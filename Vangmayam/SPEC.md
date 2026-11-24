# Vangmayam: build spec (v0.5)

An AI feed reader. The **full page** is the product: a library of sources, a timeline, a large reading pane, an AI brief. The **side panel** is a companion that follows the page you are browsing and adds its feeds to Vangmayam in one click.

## 1. Goals and non-goals

**Goals**
- Full-page reader with unread, all, starred and per-source views, search, keyboard control.
- Side panel that detects feeds on the current tab (or a right-clicked link) and follows them without leaving the page.
- Reader that loads the full article when the feed carries only an excerpt.
- AI: article summary, brief across unread items with clickable citations, chat about one article. Streaming.
- OPML import and export, background refresh, unread badge.
- No build step, no backend, no account.

**Non-goals (v0.2)**: sync across devices, clustering, paywall bypass, scraping sites with no feed.

## 2. Surfaces and entry points

| Surface | Opens from | Job |
|---|---|---|
| `app.html` (full page) | Toolbar icon (focuses the existing tab), first install | Read, search, brief, settings |
| `sidepanel.html` | Alt+Shift+F, right-click page or link, right-click toolbar icon | Detect and follow feeds for what you are viewing |

The side panel talks to the full page through the shared database and two messages: `open-app` (with an optional `feed=ID` hash) and `feeds-updated`.

## 3. Architecture

```
 side panel ──discover()──▶ the open web          app.html (full page)
     │  followFeed()            ▲                       ▲
     ▼                          │ fetch                  │ reads
 ┌──────────── IndexedDB (feeds, items) ────────────────┘
 │                    ▲
 │            background.js  ◀── alarms (refresh), badge, open-app, context menus, commands
 │                    │ parse request
 │                    ▼
 │             offscreen.js (DOMParser for XML)
```
- Manifest V3, Chrome 116 or newer.
- `<all_urls>` is an optional host permission, requested on first follow or first feed look-up (a user gesture).
- Service workers have no DOM, so XML parsing runs in an offscreen document.

## 4. Data model (IndexedDB `vangmayam` v1)

`feeds`: `{ id, url, title, siteUrl, site, kind, discover, preset, hue, folder, added, lastFetched, error }`
- `kind: 'page'` marks a site with no feed: `url` is the listing page and its article list is the feed. Absent means an RSS or Atom feed.
- `discover`: the address is a website, not a feed; the first refresh looks up its feed. `preset`: came from the catalog. `site`: where to look if the feed address stops working.
`items` (indexes `published`, `feedId`): `{ id, feedId, title, link, published, summary, html, author, image, media, read, starred, hidden, aiSummary }`
- `starred` is shown as **Saved** and exempts an item from pruning. `hidden` is **Not interested**: excluded from lists, counts and the brief, and kept so a refresh does not bring the item back.

- `feeds.id = hash(url)`; `items.id = hash(feedId | guid || link || title)`.
- First fetch of a feed stores items older than 7 days as read.
- Retention (default 28 days, 0 keeps everything) prunes unsaved items. Refresh also skips feed items older than the window so pruned items do not return.
- `chrome.storage.local`: `settings`, `brief`. `chrome.storage.session`: `pendingFollow` (link chosen from the context menu).

## 5. Modules and ownership

| # | Module | Files | Contract |
|---|---|---|---|
| A | Data | `lib/db.js`, `lib/settings.js`, `lib/util.js` | `all/get/put/del/putMany`, `queryItems`, `patchItems`, `unreadCounts`, `deleteFeed`, `prune` |
| B | Feed pipeline | `lib/parse.js`, `lib/feed.js`, `offscreen.*` | `parseFeed`, `discover(input) → [{url, feed}]`, `fetchText` |
| C | Reader engine | `lib/sanitize.js`, `lib/readable.js` | `sanitize(html, base)`, `extract(html, url) → {title, html, text}` |
| D | AI | `lib/ai.js` | `summarize`, `brief`, `ask`; callback receives accumulated text |
| E | Background | `background.js` | alarms, refresh, badge, `openApp`, side panel opening |
| I | Catalog | `lib/catalog.js` | `PACKS`, `catalogId`, `addCatalogSource`, `seedIfNeeded` |
| F | Shared UI kit | `base.css`, `lib/icons.js`, `lib/follow.js` | tokens and components; `followFeed`, `ensureHosts`, `openApp` |
| G | Full page | `app.html`, `app.css`, `app.js` | consumes A to D and F |
| H | Side panel | `sidepanel.html`, `sidepanel.css`, `sidepanel.js` | consumes A, B and F only |

Modules talk through these contracts. The UIs never parse XML; the background never touches the DOM.

## 5b. Starter packs

- Six packs ship in `lib/catalog.js`: Your picks, AI engineer, AI engineering manager, Platform engineer, Engineering blogs, Trending and news (78 unique sources).
- `seedIfNeeded()` runs on install, update, browser start and app open. Entries carry `since`; the last catalog version offered is stored in `seedVersion`, so an upgrade adds only newer sources, a removed source stays removed, and catalog titles update for preset sources.
- Seeding only writes to the database. Fetching needs the optional `<all_urls>` permission, so the app shows an Allow and load banner and the background skips refreshes until it is granted. This keeps seeded sources from showing false errors.
- The first refresh of a source marks everything older than 3 days as read, except its newest three posts, so 64 sources do not bury Unread.
- Self-healing: if a feed address fails, or the source has none, the background loads the site, collects `<link rel="alternate">` feeds (through the offscreen page) and probes common paths, then stores the working address.
- The library groups sources by folder in pack order. Folders collapse, and clicking a folder name filters the timeline to it.
- The Starter packs dialog toggles any source or a whole pack. Sources listed in several packs are one source.

## 5c. AI providers

`lib/ai.js` streams from Anthropic, OpenAI, Ollama, or Chrome's on-device summarizer (summaries only).
- **Ollama**: `POST {url}/api/chat` with `stream: true`, newline-delimited JSON, `options.num_ctx` from settings and `num_predict` per call. Article text is clipped to roughly `ctx × 3 − 2500` characters. `<think>…</think>` text from reasoning models is removed. The brief sends fewer items to small windows.
- Ollama refuses requests whose `Origin` is a browser extension. A `declarativeNetRequest` dynamic rule sets `Origin: http://127.0.0.1` on requests from the extension to the configured Ollama origin. The background updates the rule on install, start-up, settings changes and an `ollama-rule` message (sent before Detect models and on save).
- Summary, brief and Ask about this article all use the selected provider.

## 5d. Reading controls

- Row actions (Save, Mark read or unread, Not interested) render inside each row and update that row in place.
- Preferences in `localStorage`: reading width (`comfortable` 70ch, `wide` 100ch, `full`), text size, and whether the library and list are hidden. Hiding applies only while an article is open.
- Muted words are whole-word matches, applied on refresh and when the setting is saved.

## 5e. Sites with no feed (page sources)

`lib/pagefeed.js` (`extractPageItems(html, url)`) turns a listing page into feed-shaped items. It needs a DOM, so it runs in the offscreen page and the app pages.
1. **Find article links.** Same-site anchors, scored: sits under the listing path (`/blog/…`) +4, slug-like last segment +2, inside a heading +2, inside `article` or `li` +1, readable link text +1. Navigation, footer, `/tag/`, `/author/`, `/page/`, `/events/`, file links and filter or pagination links of the listing itself are dropped. Accept at 4 or more.
2. **Read the card.** Climb from the link to the largest ancestor that holds only that one article. Title: the heading that holds the link, else the first heading of 12 or more characters, else the link text. Date: `<time>`, else a date in the card text ("October 22, 2026", "22 Oct 2026", `2026-10-22`), else the URL (`/2026/10/`). Summary: first long paragraph. Picture: first image that is not an avatar or logo. Author: an `/author/` link.
3. **Order.** Newest first when most cards are dated, otherwise page order.
- A site's front page only counts when its posts are dated, so marketing pages are not mistaken for blogs.
- `discover()` falls back to pages when no feed exists: the page itself, or, for an article page (`og:type: article`), the parent path, `/blog`, `/news`, `/articles`, `/posts` or `/`.
- Refresh: `kind: 'page'` sources fetch the page and extract in the offscreen document. A catalog source with no feed that cannot be resolved falls back to page mode automatically and is converted.
- `lib/ingest.js` (`buildItems`) is the one place that turns parsed items into rows for feeds and pages: retention window, muted words, first-run read rule. Undated page items are stamped at the time they were noticed, one minute apart in page order, and a new source keeps its top five unread.

## 5f. Search

Three searches: articles (top of the list), sources in the library (name, folder or host; folders expand while searching), and the Starter packs catalog (title, note, host or pack name).

## 6. Feed discovery

1. `r/name` becomes the subreddit feed, `@handle` becomes a YouTube channel page.
2. A YouTube `/channel/UC…` URL maps directly to the channel feed.
3. Fetch the page; if it is already a feed, use it.
4. Otherwise read `<link rel="alternate">` tags (and the channel id on YouTube pages).
5. Otherwise probe `/feed`, `/rss`, `/rss.xml`, `/atom.xml`, `/feed.xml`, `/index.xml`.
6. Otherwise look for an article list to follow as a page (section 5e).

## 7. Side panel behaviour

- Follows the active tab (debounced 350 ms on tab switch or page load). Skips re-detection when the URL has not changed.
- A right-clicked link pins the panel to that link until the next tab switch. A pasted address pins it the same way.
- States: not a website, permission needed, looking (skeleton), found (one row per feed with a three-headline preview and Follow), nothing found (message plus the paste box), added (confirmation with Open in Vangmayam).
- Shows the five most recently followed sources with unread counts; each opens the full page filtered to that source.

## 8. Full page layout

```
┌ library ─┬ timeline ─────────┬ reading pane ───────────────────┐
│ Brief    │ Unread        ✓✓  │  Brief (home) or the article    │
│ Unread   │ [search]          │  summary · full text · ask      │
│ All      │ Today             │                                 │
│ Starred  │ ▌ title…          │                                 │
│ Sources  │ ▌ title…          │                                 │
└──────────┴───────────────────┴─────────────────────────────────┘
```
Below 1000px the library becomes a drawer and the reading pane slides over the timeline.

## 9. Design system

- **Source rail**: every source gets a hue from a hash of its name. A 3px edge in that colour sits beside each article (solid unread, faded read), and the same colour marks the source in the library and the side panel, so colour carries identity across both surfaces.
- **One bold moment**: the brief and summary cards draw a slowly turning multi-hue ring while the AI writes, then settle to a hairline.
- **Palette**: Salt `#F1F3F2`, Raised `#FBFCFB`, Ink `#16191C`, Slate `#4B535B`, Ultramarine `#2F4FE0`. Dark: `#14171A`, `#1C2024`, `#E9ECEE`, `#8FA3FF`. Source colours use `oklch`.
- **Type**: system book serif (Charter, Iowan Old Style, Georgia) for titles and reading, system sans for the interface. Sentence case. Reading measure about 68 characters.
- **Platform features**: `oklch()`, `color-mix()`, `@property`, `@starting-style`, `:has()`, `text-wrap: pretty`, `prefers-color-scheme`, `prefers-reduced-motion`.
- **Quality floor**: visible focus, full keyboard path, AA contrast, responsive to narrow windows.
- **Copy**: plain verbs, sentence case; errors say what happened and what to do; empty states invite an action; one word per action (Follow, Summarize, Write brief).

## 10. Security and privacy

- All feed and article HTML goes through `sanitize()`: scripts, iframes, forms, inline handlers and non-http(s) URLs removed; links use `noopener`; images load with `no-referrer`.
- Keys live in `chrome.storage.local` and go only to the chosen provider.
- Article text is sent to a provider only when the person asks for a summary, brief or chat. The on-device option sends nothing off the machine.
- The side panel reads a page's feeds only when it is open on that page. No analytics, remote code or remote fonts.

## 11. Acceptance checks

1. Toolbar icon opens or focuses the full page; it opens on first install.
2. On a blog, press Alt+Shift+F: the panel shows its feed; Follow adds it; Open in Vangmayam filters to it.
3. Right-click a link to a site: the panel pins that link and finds its feed.
4. YouTube channel, subreddit and Hacker News all resolve.
5. Unread badge matches the Unread count after a refresh.
6. Excerpt-only feeds load the full article; failures fall back to feed text with a status line.
7. Summary streams, persists, and reappears when the article is reopened.
8. Brief citations open the right article in the reading pane.
9. OPML round trip keeps every source.
10. With no API key, AI buttons explain the fix and nothing else breaks.
11. A fresh install lists 78 sources in six folders before any permission is granted; Allow and load fetches them.
12. Upgrading from v0.3 adds only the 14 newer sources and keeps removed ones removed.
13. Unticking a source in Starter packs removes it and its articles; ticking it back restores it.
14. A source with a wrong feed address heals itself, and a site with no feed becomes a page source instead of an error.
15. On an article page of a site with no feed, the side panel offers the site's article list, with three headlines previewed.
16. Upgrading converts Anthropic Engineering, the AAIF blog and news, and PlatformEngineering.org to page sources and clears their errors.
17. Searching sources in the library and in Starter packs narrows the lists; Escape clears the library search.

## 12. Roadmap

- **v0.4** Open each new article's page to read its real date and description for page sources, folders you can edit, mute keywords, ETag refresh, notifications for chosen sources, text size.
- **v0.5** Story clustering across outlets, relevance ranking, translation.
- **v0.6** Sync, shareable source lists, RSSHub bridge for sites with no feed.

## 13. Test notes

Run in Chromium with fixture pages (shaped like the AAIF, Anthropic, PlatformEngineering.org and WordPress layouts) and a stand-in for the extension APIs (storage, permissions, messaging) and a mock Ollama server: seeding and upgrade paths, row actions with undo, hidden articles surviving reload, pane hiding and width, Ollama detect, summary and chat, narrow layout, and the side panel. Also covered: page extraction against those fixtures, ingest rules, catalog migration, both searches, and the rename. Not covered by that test: real feed fetching, the offscreen parser, the `declarativeNetRequest` rule, and Chrome's permission prompts.
