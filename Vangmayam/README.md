# Vangmayam

An AI feed reader that opens as a full page in Chrome, with a side panel for adding sites while you browse. No build step.

## Install
1. Open `chrome://extensions` and switch on **Developer mode**.
2. Choose **Load unpacked** and select this folder. Vangmayam opens in a new tab.
3. Click **Follow a source**, or follow a site from the side panel (below).
4. Summaries, the brief and chat use local Ollama at `http://127.0.0.1:11434` with `llama3.2:3b`. Open **Settings** if you want a different model, or Anthropic, OpenAI, or Chrome's on-device summarizer.

## Preloaded sources
Vangmayam starts with 78 sources already in your library, grouped in folders:

| Folder | What is in it |
|---|---|
| Your picks | The Pragmatic Engineer (newsletter and podcast), Latent Space, AI Engineer (YouTube), Agentic AI Foundation blog and news, MCP and goose releases |
| AI engineer | Simon Willison, Hamel Husain, Eugene Yan, Chip Huyen, Lilian Weng, Ahead of AI, Interconnects, Import AI, Hugging Face, OpenAI, DeepMind, LangChain, Anthropic Engineering, Google Research, NVIDIA |
| AI engineering manager | Will Larson, Charity Majors, Rands in Repose, Martin Fowler, Refactoring, LeadDev, Addy Osmani, Kent Beck, High Growth Engineer, Lenny's Newsletter |
| Platform engineer | CNCF, Kubernetes, The New Stack, InfoQ, Backstage, PlatformEngineering.org, SRE Weekly, Cloudflare, Fly.io, AWS and Google Cloud, HashiCorp, Honeycomb, Humanitec |
| Engineering blogs | Netflix, Uber, Meta, GitHub Engineering and the main GitHub Blog, Atlassian (blog and developer blog), Stripe, Shopify, Spotify, Dropbox, Airbnb, Slack, LinkedIn, Discord, Vercel, Pinterest, Lyft, Instacart, Etsy, Grab, ByteByteGo, Stack Overflow |
| Trending and news | GitHub Trending (all languages, Python, TypeScript, Go), Last Week in AI, TLDR AI, Hacker News best |

- **Add or remove:** open **Starter packs** in the library. Tick a source to follow it, clear it to remove it, or use Add all and Remove all on a pack. The trash icon next to any source also unfollows it. Removed sources never come back on their own.
- **First load:** the sources are saved the moment you install, but Chrome needs your permission to read them. Vangmayam shows an **Allow and load** banner once; after that everything refreshes in the background.
- **Feeds that move:** if a feed address stops working, Vangmayam looks for the site's current feed itself. A few sources (Agentic AI Foundation, PlatformEngineering.org, Honeycomb, Humanitec, Discord, AI Engineer on YouTube) are found this way. If a site has no feed at all, its row gets a red dot and a tooltip, and you can remove it.
- **Anthropic Engineering** publishes no feed, so Vangmayam uses a community-maintained unofficial one.
- Edit the lists in `lib/catalog.js`. New packs you add there are offered to existing installs on the next update.

## Sites that have no feed
Plenty of sites publish no RSS: Anthropic Engineering, the Agentic AI Foundation blog and PlatformEngineering.org among them. Vangmayam follows their article list instead:
- Open the side panel on the site (Alt+Shift+F). If there is no feed, it finds the site's list of articles, previews three headlines, and **Follow** adds it. On an article page it looks for the site's blog or news page.
- Vangmayam reads the page for article links, titles, dates, summaries and pictures, and checks it on every refresh. New cards become new articles.
- Pages with no dates show articles in page order; the top card counts as newest. Articles can take a refresh to appear after the site publishes them.
- A page that is mostly navigation, or a site's front page without dated posts, is not treated as a list.

## Search
- **Search sources** (above the source list) filters your library by name, folder or site.
- **Search sources and packs** in Starter packs finds sources you do not follow yet.
- **Search articles** (top of the list, key `/`) searches the articles themselves.

## Local AI with Ollama
1. This copy already points at Ollama on `http://127.0.0.1:11434` and the model `llama3.2:3b`.
2. In **Settings**, **Detect models** lists whatever else `ollama list` shows, if you want to switch.
3. Summaries, the brief and **Ask about this article** all use that model. Nothing leaves your computer.

Vangmayam rewrites the `Origin` header on requests to your Ollama address, so you do not need to set `OLLAMA_ORIGINS`. Pick a context window that matches your model; long articles are trimmed to fit it.

## Reading and keeping
- **Save** keeps an article for good. Everything else is deleted after 4 weeks (change this in Settings, or choose Never).
- **Not interested** hides an article and its count. Undo appears for a few seconds, and **Settings** can show hidden articles again. You can also list words to hide automatically.
- **Row buttons** appear when you hover over an article in the list: Save, Mark as read or unread, Not interested.
- **Read in the full window:** the toolbar above an article hides the library and the article list, changes the reading width (comfortable, wide, full) and the text size. They return when you close the article.
- The title above the list, and the source name above an article, open that blog in a new tab.

## Upgrading from Fathom
This version was renamed from Fathom. To keep your library, saved articles and settings, copy these files over the folder you already loaded and press reload on `chrome://extensions`. Loading from a different folder gives Chrome a new extension id and an empty library; choose Export OPML in Settings first if you do that. Internally the database keeps its old name so nothing needs converting.

## Two surfaces
- **Full page (toolbar icon).** Library, timeline, reading pane, brief, search, settings.
- **Side panel (Alt+Shift+F).** Shows the page you are on, finds its feeds, and follows them in one click. It also opens from the right-click menu (**Follow this site in Vangmayam**), on a link too, and from the toolbar icon's own right-click menu. It follows you as you switch tabs.

Change the shortcut at `chrome://extensions/shortcuts`.

## Keys in the full page
`j` and `k` move, `Enter` opens, `Esc` goes back, `s` saves, `m` marks read or unread, `x` not interested, `[` and `]` hide the library and the list, `f` reads in the full window, `+` and `-` change text size, `r` refreshes, `/` searches.

See `SPEC.md` for architecture, module contracts and roadmap.
