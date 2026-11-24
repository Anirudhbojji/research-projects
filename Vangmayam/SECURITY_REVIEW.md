# Vangmayam security review (2026-11-23)

Scope: full read of `manifest.json`, `background.js`, `offscreen.js`, `app.js`, `sidepanel.js` and every file in `lib/`. Static review only, nothing was run in a browser.

## What Vangmayam is

A Manifest V3 Chrome extension that works as an RSS/Atom feed reader with AI summaries. Everything runs locally with no backend.

- `background.js` (service worker): alarms refresh every feed every 20 min, keeps the unread badge, opens the app tab, installs a `declarativeNetRequest` rule that rewrites the `Origin` header on requests to the configured Ollama address.
- `offscreen.js`: a hidden document that owns `DOMParser`, used to parse XML feeds and scrape listing pages for sites with no feed.
- `app.html` + `app.js`: the full-page reader. Library, timeline, reading pane, AI brief, chat, settings, OPML import/export.
- `sidepanel.js`: watches the active tab, fetches the page, discovers feeds (`<link rel=alternate>`, common probe paths, YouTube/Reddit shortcuts, or page scraping) and follows them.
- `lib/sanitize.js` + `lib/readable.js`: allow-list HTML sanitizer and article extractor. All feed HTML and fetched article HTML goes through `sanitize()` before `innerHTML`.
- `lib/ai.js`: streams to Anthropic, OpenAI, Ollama or Chrome's on-device summarizer. Keys live in `chrome.storage.local`.
- `lib/db.js`: IndexedDB `fathom` with `feeds` and `items`. Ids are a 32-bit FNV-1a hash (`lib/util.js`).
- Permissions: `sidePanel, storage, alarms, offscreen, tabs, contextMenus, declarativeNetRequest`; host access to Anthropic, OpenAI, localhost, 127.0.0.1; `<all_urls>` as an optional permission requested on first follow.

## What is done well

- No custom CSP, so MV3 defaults apply: no inline script, no eval, no remote code. Even a sanitizer bypass could not run script.
- `sanitize()` is an allow-list (tags and per-tag attributes), strips `style`, `srcset`, `id`, `name`, event handlers, `svg`, `math`, `iframe`, `form`, `template`. Links get `target=_blank rel="noopener noreferrer"`. Images get `referrerpolicy=no-referrer`. Only `http(s)`, `mailto:` and `data:image/{png,jpeg,gif,webp}` URLs survive.
- Every dynamic string in `app.js` and `sidepanel.js` goes through `esc()` before `innerHTML`, or uses `textContent`. `md()` escapes first and only re-introduces `<strong>`, `<ul>`, `<h4>` and numeric cite buttons, so AI output cannot inject markup.
- Outbound link targets (`#r-open`, source title links) are gated by `httpUrl()`.
- Feed fetches use `credentials: 'omit'` and an abort timeout.
- No `externally_connectable`, no content scripts, so web pages cannot message the extension.
- API key fields are `type=password autocomplete=off`.

## Findings

Severity is relative to a local, single-user reader extension. Nothing here is remotely exploitable for code execution.

### 1. Medium: forgeable item and feed ids (32-bit FNV-1a). FIXED 2026-11-23

`lib/util.js:4` `hash()` is 32-bit FNV-1a. `items.id = hash(feedId|guid)` and `feeds.id = hash(url)`.

- The `guid` is fully attacker-controlled by any feed you follow. FNV-1a is not collision resistant and the output space is 32 bits, so a feed can emit a guid whose id equals an item from another feed. `db.putMany` uses `put` (upsert) and `known` in `background.js:170` only lists this feed's own item ids, so the forged row overwrites the other feed's article: title, link, html, `feedId`, and `starred` (a saved article is lost).
- Accidental collisions also become likely around tens of thousands of stored items (birthday bound).

Applied: item ids are now `${feedId}:${hash(...)}` (`lib/ingest.js`), so the id space is partitioned per feed and a guid can only ever collide with the publishing feed's own rows. The hashed part is unchanged, and `lib/db.js` bumps the schema to v2 with an in-place re-key of existing rows, so an upgrade neither re-downloads nor re-marks anything unread. Feed ids keep the 32-bit hash: every feed write is guarded by an exists-check (`followFeed`, `importOpml`, `addCatalogSource`, `seedIfNeeded`), so a colliding feed URL is reported as already followed rather than overwriting. Within one feed, accidental collision odds stay below 0.1% at a few thousand items.

### 2. Medium: unbounded response bodies and parsing (DoS of the extension). FIXED 2026-11-23

`lib/feed.js:15` does `await r.text()` with no size cap, and `parseFeed` / `extractPageItems` run on the whole document. A followed feed or any site the side panel lands on can return a multi-gigabyte body and OOM the service worker or offscreen document; the refresh chain (`background.js:213`) then stalls for every feed. `html.slice(0, 200000)` in `lib/ingest.js:35` only applies after parsing.

Applied: `fetchText` checks `content-length`, then streams the body and cancels past `MAX_BYTES` (5 MB) with a clear error that lands in the source's error tooltip.

### 3. Medium: feeds steer the extension to fetch arbitrary URLs, including localhost and private ranges. FIXED 2026-11-23

- `loadFull()` in `app.js:387` fetches `it.link` from the extension context, automatically when feed text is short. `resolveFeed`, `probeUrls`, redirects and `<link rel=alternate>` all follow feed-supplied URLs with `<all_urls>` once granted. `normalizeInput` explicitly allows `localhost`.
- The manifest already grants `http://localhost/*` and `http://127.0.0.1/*` on every port without a prompt.
- Result: a malicious feed can make the user's browser GET `http://127.0.0.1:<port>/...` or `http://10.x/...`, render the response in the reader, and, if the user clicks Summarize, ship it to the chosen AI provider. There is no channel back to the attacker, so this is a read-into-the-user's-own-screen primitive, not exfiltration, but it is still an SSRF-shaped behaviour.
- `background.js:177` also persists `result.url` (the post-redirect URL) as the feed's address, so a one-time redirect permanently repoints a source.

Applied: `fetchText` accepts http(s) only and refuses private or local hosts (loopback, RFC 1918, CGNAT, link-local, multicast, IPv6 equivalents including hex-form IPv4-mapped addresses, `localhost`, `.local`, `.internal`, `.home.arpa`, bare names) unless the URL shares an origin with `trustedOrigin`. Callers pass the origin the person typed (`discover`) or the followed feed's own origin (background refresh, full-article load), so a self-hosted bridge on the LAN still works while links and alternates pointing inside the network do not. The post-redirect URL is checked the same way, and `fetchParsed` only stores a redirect target as the feed's new address when it stays on the feed's origin.

Remaining limits: hostnames are not resolved, so a public name that resolves to a private address (DNS rebinding) passes; intermediate redirect hops are requested by the browser before the final URL is checked; the Ollama client in `lib/ai.js` is deliberately exempt because its address is user-configured.

### 4. Medium: side panel re-fetches whatever URL the active tab shows. FIXED 2026-11-24

`sidepanel.js:178` runs `detect()` on every tab update while the panel is open, and `discover()` in `lib/feed.js:116` fetches that exact URL plus `/feed`, `/rss`, `/blog`, `/news` and so on. URLs that carry single-use tokens (password reset, magic login, unsubscribe, signed download links) get requested a second time from the extension. Cookies are omitted, but the token in the query string is enough for many of those endpoints, so the panel can consume or trigger them. Also, intranet and admin pages are re-requested.

Applied: `autoDiscoveryUrl` in `lib/feed.js` decides what the panel may request on its own. A tab's address is reduced to scheme, host and path plus a short allow-list of page-naming query parameters (`v`, `list`, `channel_id`, `feed`, `format`, `p`, `page_id`, `cat`, `tag`, values up to 64 characters); the fragment and any credentials are dropped. The panel does not request the page at all, and tells the person to paste the site's address instead, when the tab is not http(s), is on a local or private host, or looks like a one-time link: a parameter name matching token, key, auth, code, sig, session, pass, secret, nonce, state, otp, verify, confirm, reset, unsubscribe, ticket, jwt, login, magic, invite, activate, hash or expires; a path segment such as `login`, `oauth`, `reset`, `unsubscribe`, `verify`, `confirm`, `activate`, `invite`; or any parameter value or path segment that is 32+ hex characters or a 24+ character hyphen-free run of mixed letters and digits. Typed addresses and right-clicked links are explicit choices and are passed to `discover` as given. Automatic detection on public pages is kept, because following the page you are on is the panel's purpose.

Remaining limits: the token heuristic is a heuristic; a short or hyphenated token under a harmless parameter name passes, and the probe paths (`/feed`, `/rss`...) are still requested on the page's origin. A page whose path itself is the secret and is not token-shaped is re-requested once without its query string.

### 5. Low: prompt injection across sources through the brief

`ai.brief()` concatenates titles and summaries of up to 60 unread items from every feed into one prompt. One malicious feed can instruct the model to misrepresent other sources, suppress items, or push its own item as "Worth your time". Output is rendered through `md()` so no markup injection, but the citation buttons do open items, and opening one triggers the auto fetch in finding 3. Also `ask()` puts the article text in the system prompt.

Fix: wrap item text in delimiters and tell the model it is untrusted data; cap per-item length (already 200 chars for summary, titles are not capped).

### 6. Low: OPML import accepts any string as a feed URL. FIXED 2026-11-24

`app.js:612` stores `xmlUrl` verbatim (`javascript:`, `file:`, `data:` all pass). Rendering is guarded (`httpUrl`, `hostOf`), and the background `fetch` will fail for non-http, but `file://` could succeed if the user enabled "Allow access to file URLs". Validate with `normalizeInput()` on import.

Applied: `opmlUrl` in `app.js` keeps an entry only when it starts with `http://` or `https://`, passes `normalizeInput`, and its host is not private or local (`isPrivateHost`). Everything else is counted and reported in the toast as skipped. Private hosts are excluded on purpose: a feed's own origin is trusted during refresh (finding 3), so a file with hundreds of entries must not be able to slip in `http://127.0.0.1:<port>/...`; a local bridge is added by typing its address, one deliberate choice at a time. `htmlUrl` goes through `httpUrl`, and titles and folder names are capped.

### 7. Low: tracking by design (read receipts)

Thumbnails in the list (`rowHtml`) and inline images load on render, and `loadFull` fetches the article on open. Both tell the publisher when you looked. `no-referrer` is set and lazy loading limits the list, but there is no "load images on click" option. Standard for feed readers; worth a setting.

### 8. Low: API keys and settings are plaintext in `chrome.storage.local`

Standard for extensions and there is no better primitive in Chrome, but anything that can read the profile directory (malware, backups, another user on the machine) gets the Anthropic and OpenAI keys. The Anthropic call uses `anthropic-dangerous-direct-browser-access`, which is the intended header for this case. Document the risk; recommend scoped, low-limit keys.

### 9. Low: `allowOllama()` grants the whole host, every port, and the Origin rewrite follows it

`app.js:674` requests `${protocol}//${hostname}/*` (no port) for whatever the user typed, and `syncOllamaRule` then sends `Origin: http://127.0.0.1` to that origin. If a user points it at a remote host, article text goes there and the request lies about its origin. User's choice, but the permission should include the port and the rule should be limited to loopback/private hosts.

### 10. Low: `<all_urls>` instead of per-site optional permissions

Every followed site works through one blanket grant. Requesting `origins: [new URL(feed).origin + '/*']` per follow would make the blast radius of findings 3 and 4 much smaller at the cost of one prompt per new site.

### 11. Informational

- `hash()` also drives `hueFor`, harmless.
- `extractPageItems` is O(anchors × ancestors × anchors) on big pages: CPU, not security.
- `extract()` and `pagefeed` strip `[aria-hidden="true"]`, which can be used by a site to hide text from the reader or the summarizer (and the reverse: hidden prompt-injection text in `<p>` is sent to the model while invisible on the page).
- Four catalog sources are community mirrors on `github.io`. A takeover of that account feeds every install. Not a bug, a trust dependency to note in the README.
- Comments (`<!-- -->`) pass through the sanitizer unchanged. Harmless.
- No HTTPS enforcement: typed `http://` feeds stay plain HTTP and are MITM-able. Catalog entries are all HTTPS.

## Not found

- No XSS path: every `innerHTML` sink is either `esc()`-ed, `md()`-ed, or `sanitize()`-ed, and the default MV3 CSP backs it up.
- No DOM clobbering: `id`/`name` attributes never survive the sanitizer.
- No reverse tabnabbing: `rel="noopener noreferrer"` on all generated links.
- No message-passing exposure: no `externally_connectable`, no content scripts, no `web_accessible_resources`.
- No XXE: browser `DOMParser` does not resolve external entities.

## Suggested order of remaining fixes

1. Delimit feed text in prompts and cap title length (finding 5).
2. Add "load images on demand" (finding 7).
3. Per-site permissions and port-scoped Ollama grant (findings 9, 10).

## Verification of the applied fixes

`node --check` passes on every changed module. A Node test with a mocked `fetch` covers: private and public host classification (including canonicalised forms such as `http://0x7f.1/` and `[::ffff:7f00:1]`), rejection of `file:` and `javascript:`, private host allowed only on the trusted origin and not on another port, redirect landing on a private address, `content-length` over the cap, a streamed body over and under the cap, and that two feeds publishing the same guid get different item ids. Not exercised: the IndexedDB v2 migration, which needs a browser; load the unpacked extension over an existing library and confirm the unread count does not jump.

For findings 4 and 6 the same suite (79 checks on 2026-11-24) covers `autoDiscoveryUrl`: tracking parameters and fragments dropped, a YouTube video id and a WordPress `?feed=` kept, a hyphenated slug with digits not mistaken for a token, and skips for token, code, session and unsubscribe links, a JWT or hex id in the path, embedded credentials, local and private hosts, and non-web schemes. The OPML rule is tested as the same expression as `opmlUrl` (the function lives in `app.js`, which needs a DOM): https kept and normalised, `javascript:`, `file:`, `data:`, scheme-less, loopback, `localhost` and bare-name entries rejected. Not exercised in a browser: the side panel notes and the import toast.
