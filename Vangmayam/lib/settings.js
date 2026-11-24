export const DEFAULTS = {
  provider: 'ollama', // 'anthropic' | 'openai' | 'ollama' | 'chrome'
  anthropicKey: '',
  anthropicModel: 'claude-haiku-5-5',
  openaiKey: '',
  openaiModel: 'gpt-4o-mini',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'llama3.2:3b',
  ollamaCtx: 8192,
  language: 'English',
  refreshMinutes: 20,
  retentionDays: 28, // 0 keeps everything
  mutedWords: '',
};

export async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...settings };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  await chrome.storage.local.set({ settings: { ...cur, ...patch } });
}
