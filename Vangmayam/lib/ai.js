import { getSettings } from './settings.js';

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

async function readLines(res, onLine) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) onLine(line);
  }
  if (buf.trim()) onLine(buf);
}

/** Server-sent events: lines that start with "data:". */
const readSSE = (res, onEvent) =>
  readLines(res, (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try { onEvent(JSON.parse(data)); } catch { /* ignore partial frames */ }
  });

/** Newline-delimited JSON, which is how Ollama streams. */
const readNDJSON = (res, onEvent) =>
  readLines(res, (line) => {
    if (!line.trim()) return;
    try { onEvent(JSON.parse(line)); } catch { /* ignore partial frames */ }
  });

async function failure(res) {
  const j = await res.json().catch(() => null);
  const msg = j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || `HTTP ${res.status}`;
  if (res.status === 401) return new Error('The API key was rejected. Check it in Settings.');
  return new Error(msg);
}

/** Local models have small context windows, so give them less text. */
function budget(s, wanted) {
  if (s.provider !== 'ollama') return wanted;
  const ctx = Number(s.ollamaCtx) || 8192;
  return Math.max(3000, Math.min(wanted, Math.round(ctx * 3 - 2500)));
}

// Reasoning models write their thinking between <think> tags. Readers do not need it.
const stripThinking = (t) => t.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/^\s+/, '');

async function ollamaChat(s, system, messages, emit, maxTokens) {
  const base = (s.ollamaUrl || 'http://localhost:11434').replace(/\/+$/, '');
  if (!s.ollamaModel) throw new Error('Choose an Ollama model in Settings.');
  let res;
  try {
    res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: s.ollamaModel,
        stream: true,
        messages: [{ role: 'system', content: system }, ...messages],
        options: { num_ctx: Number(s.ollamaCtx) || 8192, num_predict: maxTokens },
      }),
    });
  } catch {
    throw new Error(`Could not reach Ollama at ${base}. Start Ollama and try again.`);
  }
  if (res.status === 403) throw new Error('Ollama refused the request. Open Settings and choose Save settings to repair access.');
  if (res.status === 404) throw new Error(`Ollama has no model named ${s.ollamaModel}. Run: ollama pull ${s.ollamaModel}`);
  if (!res.ok) throw await failure(res);
  await readNDJSON(res, (ev) => {
    if (ev.error) throw new Error(ev.error);
    if (ev.message?.content) emit(ev.message.content);
  });
}

async function stream(system, messages, onText, maxTokens = 1200) {
  const s = await getSettings();
  let acc = '';
  const emit = (d) => {
    acc += d;
    onText(s.provider === 'ollama' ? stripThinking(acc) : acc);
  };

  if (s.provider === 'anthropic') {
    if (!s.anthropicKey) throw new Error('Add your Anthropic API key in Settings to use AI.');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': s.anthropicKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: s.anthropicModel, max_tokens: maxTokens, stream: true, system, messages }),
    });
    if (!res.ok) throw await failure(res);
    await readSSE(res, (ev) => { if (ev.type === 'content_block_delta' && ev.delta?.text) emit(ev.delta.text); });
  } else if (s.provider === 'openai') {
    if (!s.openaiKey) throw new Error('Add your OpenAI API key in Settings to use AI.');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${s.openaiKey}` },
      body: JSON.stringify({ model: s.openaiModel, stream: true, messages: [{ role: 'system', content: system }, ...messages] }),
    });
    if (!res.ok) throw await failure(res);
    await readSSE(res, (ev) => { const d = ev.choices?.[0]?.delta?.content; if (d) emit(d); });
  } else if (s.provider === 'ollama') {
    await ollamaChat(s, system, messages, emit, maxTokens);
  } else {
    throw new Error('This feature needs Ollama, Anthropic or OpenAI. Choose one in Settings.');
  }
  return s.provider === 'ollama' ? stripThinking(acc) : acc;
}

async function chromeSummarize(text, onText, type) {
  if (!('Summarizer' in self)) throw new Error('This version of Chrome has no on-device summarizer. Pick a provider in Settings.');
  const availability = await Summarizer.availability();
  if (availability === 'unavailable') throw new Error('The on-device summarizer is not available on this computer.');
  const summarizer = await Summarizer.create({ type, format: 'plain-text', length: 'medium' });
  let acc = '';
  for await (const chunk of summarizer.summarizeStreaming(clip(text, 20000))) {
    acc += chunk;
    onText(acc);
  }
  summarizer.destroy?.();
  return acc;
}

export async function summarize({ title, text }, onText) {
  const s = await getSettings();
  if (s.provider === 'chrome') return chromeSummarize(`${title}\n\n${text}`, onText, 'tldr');
  const system =
    `You write summaries for a busy reader. Reply in ${s.language}. Open with one plain sentence stating the main point. ` +
    'Then give 3 to 5 short bullet points, each starting with "- ", with the specific facts, numbers and names that matter. ' +
    'No preamble and no closing remarks.';
  return stream(system, [{ role: 'user', content: `Title: ${title}\n\n${clip(text, budget(s, 24000))}` }], onText, 700);
}

/** items: [{ source, title, summary }] numbered from 1 in the order given. */
export async function brief(items, onText) {
  const s = await getSettings();
  const cap = s.provider === 'ollama' ? Math.max(12, Math.min(items.length, Math.floor(budget(s, 20000) / 280))) : items.length;
  const lines = items.slice(0, cap).map((it, i) => `[${i + 1}] ${it.source}: ${it.title}. ${clip(it.summary || '', 200)}`).join('\n');
  if (s.provider === 'chrome') return chromeSummarize(lines, onText, 'key-points');
  const system =
    `You are an editor writing a brief from a reader's unread feed items. Reply in ${s.language}. ` +
    'Group related items into 3 to 6 themes. For each theme write a short bold title on its own line using **double asterisks**, ' +
    'then 2 to 3 sentences on what happened and why it matters. Cite the items you used with their numbers in square brackets, like [3] or [3, 7]. ' +
    'Skip items that are noise. Finish with one line that starts with "Worth your time:" naming the single most important item with its number.';
  return stream(system, [{ role: 'user', content: lines }], onText, 1500);
}

export async function ask({ title, text }, history, onText) {
  const s = await getSettings();
  const system =
    `Answer the reader's questions using only the article below. If the article does not cover it, say so. Be brief. Reply in ${s.language}.\n\n` +
    `Title: ${title}\n\n${clip(text, budget(s, 20000))}`;
  return stream(system, history, onText, 800);
}

/** Models installed in a local Ollama. Throws a readable error when it cannot be reached. */
export async function listOllamaModels(url) {
  const base = (url || 'http://localhost:11434').replace(/\/+$/, '');
  let res;
  try { res = await fetch(`${base}/api/tags`); } catch { throw new Error(`Could not reach Ollama at ${base}. Start Ollama and try again.`); }
  if (res.status === 403) throw new Error('Ollama refused the request. Choose Save settings, then try again.');
  if (!res.ok) throw new Error(`Ollama answered with HTTP ${res.status}.`);
  const j = await res.json();
  return (j.models || []).map((m) => m.name).sort();
}
