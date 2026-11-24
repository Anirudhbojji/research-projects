import { parseFeed, feedLinksFromHtml } from './lib/parse.js';
import { extractPageItems } from './lib/pagefeed.js';

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg?.target !== 'offscreen') return;
  try {
    if (msg.type === 'parse') send({ ok: true, feed: parseFeed(msg.xml, msg.url) });
    else if (msg.type === 'find-links') send({ ok: true, links: feedLinksFromHtml(msg.html, msg.url) });
    else if (msg.type === 'extract-page') send({ ok: true, feed: extractPageItems(msg.html, msg.url) });
  } catch (e) {
    send({ ok: false, error: e.message });
  }
});
