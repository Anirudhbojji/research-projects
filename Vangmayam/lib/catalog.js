import * as db from './db.js';
import { hash, hueFor } from './util.js';

// Each source has a `site` (always) and a `feed` (when the address is known).
// Sources without a `feed` are resolved by looking for the site's feed link the
// first time they refresh, and if the site has none, its article list is followed
// instead. If a known `feed` stops working, the same lookup runs against `site`.
// `page: true` marks a site known to publish no feed: Vangmayam follows the page itself.
// `key` keeps a source's id stable when its address changes.
// Bump CATALOG_VERSION when you add sources. Entries carry `since` (the version that
// introduced them, default 1). People who already have an older catalog get only the
// entries newer than the version they last saw, so sources they removed stay removed.
export const CATALOG_VERSION = 3;

export const PACKS = [
  {
    id: 'picks',
    name: 'Your picks',
    blurb: 'The sources you asked for by name.',
    feeds: [
      { title: 'The Pragmatic Engineer', feed: 'https://newsletter.pragmaticengineer.com/feed', site: 'https://newsletter.pragmaticengineer.com' },
      { title: 'The Pragmatic Engineer podcast', feed: 'https://api.substack.com/feed/podcast/458709.rss', site: 'https://newsletter.pragmaticengineer.com/podcast' },
      { title: 'Latent Space', feed: 'https://www.latent.space/feed', site: 'https://www.latent.space', note: 'The AI Engineer newsletter' },
      { title: 'Latent Space podcast', feed: 'https://api.substack.com/feed/podcast/1084089.rss', site: 'https://www.latent.space/podcast' },
      { title: 'AI Engineer (YouTube)', site: 'https://www.youtube.com/@aiDotEngineer', note: 'Talks from AI Engineer events' },
      { title: 'Agentic AI Foundation blog', site: 'https://aaif.io/blog', page: true, note: 'No feed, so Vangmayam follows the page' },
      { title: 'Agentic AI Foundation news', site: 'https://aaif.io/news', page: true, note: 'No feed, so Vangmayam follows the page' },
      { title: 'Model Context Protocol releases', feed: 'https://github.com/modelcontextprotocol/modelcontextprotocol/releases.atom', site: 'https://github.com/modelcontextprotocol/modelcontextprotocol', note: 'An AAIF project' },
      { title: 'goose releases', feed: 'https://github.com/block/goose/releases.atom', site: 'https://github.com/block/goose', note: 'An AAIF project' },
    ],
  },
  {
    id: 'ai-engineer',
    name: 'AI engineer',
    blurb: 'Models, evals, agents and tooling from people who ship them.',
    feeds: [
      { title: 'Latent Space', feed: 'https://www.latent.space/feed', site: 'https://www.latent.space' },
      { title: 'Simon Willison', feed: 'https://simonwillison.net/atom/everything/', site: 'https://simonwillison.net' },
      { title: 'Hamel Husain', feed: 'https://hamel.dev/index.xml', site: 'https://hamel.dev', note: 'Evals and applied LLMs' },
      { title: 'Eugene Yan', feed: 'https://eugeneyan.com/rss/', site: 'https://eugeneyan.com' },
      { title: 'Chip Huyen', feed: 'https://huyenchip.com/feed.xml', site: 'https://huyenchip.com' },
      { title: 'Lilian Weng', feed: 'https://lilianweng.github.io/index.xml', site: 'https://lilianweng.github.io' },
      { title: 'Ahead of AI (Sebastian Raschka)', feed: 'https://magazine.sebastianraschka.com/feed', site: 'https://magazine.sebastianraschka.com' },
      { title: 'Interconnects', feed: 'https://www.interconnects.ai/feed', site: 'https://www.interconnects.ai' },
      { title: 'Import AI', feed: 'https://importai.substack.com/feed', site: 'https://importai.substack.com' },
      { title: 'Hugging Face blog', feed: 'https://huggingface.co/blog/feed.xml', site: 'https://huggingface.co/blog' },
      { title: 'OpenAI news', feed: 'https://openai.com/news/rss.xml', site: 'https://openai.com/news' },
      { title: 'Google DeepMind blog', feed: 'https://deepmind.google/blog/rss.xml', site: 'https://deepmind.google/blog' },
      { title: 'LangChain blog', feed: 'https://blog.langchain.com/rss/', site: 'https://blog.langchain.com' },
      { title: 'Anthropic Engineering', key: 'https://znck.github.io/feeds/anthropic-engineering.xml', site: 'https://www.anthropic.com/engineering', page: true, note: 'No feed, so Vangmayam follows the page' },
      { title: 'Google Research blog', feed: 'https://research.google/blog/rss/', site: 'https://research.google/blog', since: 2 },
      { title: 'NVIDIA Technical Blog', feed: 'https://developer.nvidia.com/blog/feed', site: 'https://developer.nvidia.com/blog', since: 2 },
    ],
  },
  {
    id: 'ai-eng-manager',
    name: 'AI engineering manager',
    blurb: 'Leading teams that build with AI: hiring, delivery, org design and the craft of management.',
    feeds: [
      { title: 'The Pragmatic Engineer', feed: 'https://newsletter.pragmaticengineer.com/feed', site: 'https://newsletter.pragmaticengineer.com' },
      { title: 'The Pragmatic Engineer podcast', feed: 'https://api.substack.com/feed/podcast/458709.rss', site: 'https://newsletter.pragmaticengineer.com/podcast' },
      { title: 'Irrational Exuberance (Will Larson)', feed: 'https://lethain.com/feeds/', site: 'https://lethain.com' },
      { title: 'Charity Majors', feed: 'https://charity.wtf/feed/', site: 'https://charity.wtf' },
      { title: 'Rands in Repose', feed: 'https://randsinrepose.com/feed/', site: 'https://randsinrepose.com' },
      { title: 'Martin Fowler', feed: 'https://martinfowler.com/feed.atom', site: 'https://martinfowler.com' },
      { title: 'Refactoring (Luca Rossi)', feed: 'https://refactoring.fm/feed', site: 'https://refactoring.fm' },
      { title: 'LeadDev', feed: 'https://leaddev.com/feed', site: 'https://leaddev.com' },
      { title: 'Elevate (Addy Osmani)', feed: 'https://addyo.substack.com/feed', site: 'https://addyo.substack.com' },
      { title: 'Tidy First? (Kent Beck)', feed: 'https://tidyfirst.substack.com/feed', site: 'https://tidyfirst.substack.com' },
      { title: 'High Growth Engineer', feed: 'https://www.highgrowthengineer.com/feed', site: 'https://www.highgrowthengineer.com' },
      { title: 'Lenny’s Newsletter', feed: 'https://www.lennysnewsletter.com/feed', site: 'https://www.lennysnewsletter.com', note: 'Product and growth' },
    ],
  },
  {
    id: 'platform-engineer',
    name: 'Platform engineer',
    blurb: 'Internal platforms, Kubernetes, reliability and developer experience.',
    feeds: [
      { title: 'CNCF blog', feed: 'https://www.cncf.io/feed/', site: 'https://www.cncf.io/blog' },
      { title: 'Kubernetes blog', feed: 'https://kubernetes.io/feed.xml', site: 'https://kubernetes.io/blog' },
      { title: 'The New Stack', feed: 'https://thenewstack.io/feed/', site: 'https://thenewstack.io' },
      { title: 'InfoQ', feed: 'https://feed.infoq.com/', site: 'https://www.infoq.com', note: 'All topics' },
      { title: 'Backstage blog', feed: 'https://backstage.io/blog/rss.xml', site: 'https://backstage.io/blog' },
      { title: 'PlatformEngineering.org', site: 'https://platformengineering.org/blog', page: true, note: 'No feed, so Vangmayam follows the page' },
      { title: 'SRE Weekly', feed: 'https://sreweekly.com/feed/', site: 'https://sreweekly.com' },
      { title: 'Cloudflare blog', feed: 'https://blog.cloudflare.com/rss/', site: 'https://blog.cloudflare.com' },
      { title: 'Fly.io blog', feed: 'https://fly.io/blog/feed.xml', site: 'https://fly.io/blog' },
      { title: 'AWS Architecture Blog', feed: 'https://aws.amazon.com/blogs/architecture/feed/', site: 'https://aws.amazon.com/blogs/architecture' },
      { title: 'Google Cloud blog', feed: 'https://cloudblog.withgoogle.com/rss/', site: 'https://cloud.google.com/blog' },
      { title: 'HashiCorp blog', feed: 'https://www.hashicorp.com/blog/feed.xml', site: 'https://www.hashicorp.com/blog' },
      { title: 'Honeycomb blog', site: 'https://www.honeycomb.io/blog', note: 'Feed is looked up automatically' },
      { title: 'Humanitec blog', site: 'https://humanitec.com/blog', note: 'Feed is looked up automatically' },
    ],
  },
  {
    id: 'eng-blogs',
    name: 'Engineering blogs',
    blurb: 'How large teams build and run software.',
    feeds: [
      { title: 'Netflix TechBlog', feed: 'https://netflixtechblog.com/feed', site: 'https://netflixtechblog.com' },
      { title: 'Uber Engineering', feed: 'https://www.uber.com/blog/engineering/rss/', site: 'https://www.uber.com/blog/engineering' },
      { title: 'Meta Engineering', feed: 'https://engineering.fb.com/feed/', site: 'https://engineering.fb.com' },
      { title: 'GitHub Engineering', feed: 'https://github.blog/engineering/feed/', site: 'https://github.blog/engineering' },
      { title: 'The GitHub Blog', feed: 'https://github.blog/feed/', site: 'https://github.blog', note: 'Everything GitHub publishes', since: 2 },
      { title: 'Atlassian blog', feed: 'https://www.atlassian.com/blog/rss', site: 'https://www.atlassian.com/blog', since: 2 },
      { title: 'Atlassian developer blog', feed: 'https://blog.developer.atlassian.com/feed/', site: 'https://blog.developer.atlassian.com', since: 2 },
      { title: 'ByteByteGo', feed: 'https://blog.bytebytego.com/feed', site: 'https://blog.bytebytego.com', note: 'System design', since: 2 },
      { title: 'Stack Overflow blog', feed: 'https://stackoverflow.blog/feed/', site: 'https://stackoverflow.blog', since: 2 },
      { title: 'Stripe blog', feed: 'https://stripe.com/blog/feed.rss', site: 'https://stripe.com/blog', note: 'Includes engineering posts' },
      { title: 'Shopify Engineering', feed: 'https://shopify.engineering/blog.atom', site: 'https://shopify.engineering' },
      { title: 'Spotify Engineering', feed: 'https://engineering.atspotify.com/feed/', site: 'https://engineering.atspotify.com' },
      { title: 'Dropbox Tech', feed: 'https://dropbox.tech/feed', site: 'https://dropbox.tech' },
      { title: 'Airbnb Engineering', feed: 'https://medium.com/feed/airbnb-engineering', site: 'https://medium.com/airbnb-engineering' },
      { title: 'Slack Engineering', feed: 'https://slack.engineering/feed/', site: 'https://slack.engineering' },
      { title: 'LinkedIn Engineering', feed: 'https://engineering.linkedin.com/blog.rss.html', site: 'https://engineering.linkedin.com/blog' },
      { title: 'Discord Engineering', site: 'https://discord.com/category/engineering', note: 'Feed is looked up automatically' },
      { title: 'Vercel blog', feed: 'https://vercel.com/atom', site: 'https://vercel.com/blog' },
      { title: 'Pinterest Engineering', feed: 'https://medium.com/feed/pinterest-engineering', site: 'https://medium.com/pinterest-engineering' },
      { title: 'Lyft Engineering', feed: 'https://eng.lyft.com/feed', site: 'https://eng.lyft.com' },
      { title: 'Instacart Tech', feed: 'https://tech.instacart.com/feed', site: 'https://tech.instacart.com' },
      { title: 'Etsy Code as Craft', feed: 'https://www.etsy.com/codeascraft/rss', site: 'https://www.etsy.com/codeascraft' },
      { title: 'Grab Engineering', feed: 'https://engineering.grab.com/feed.xml', site: 'https://engineering.grab.com' },
    ],
  },
  {
    id: 'trending',
    name: 'Trending and news',
    blurb: 'What is moving this week: trending repositories, AI news and the front page of Hacker News.',
    feeds: [
      { title: 'GitHub Trending today', feed: 'https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml', site: 'https://github.com/trending', note: 'All languages, community feed', since: 2 },
      { title: 'GitHub Trending: Python', feed: 'https://mshibanami.github.io/GitHubTrendingRSS/daily/python.xml', site: 'https://github.com/trending/python', note: 'Community feed', since: 2 },
      { title: 'GitHub Trending: TypeScript', feed: 'https://mshibanami.github.io/GitHubTrendingRSS/daily/typescript.xml', site: 'https://github.com/trending/typescript', note: 'Community feed', since: 2 },
      { title: 'GitHub Trending: Go', feed: 'https://mshibanami.github.io/GitHubTrendingRSS/daily/go.xml', site: 'https://github.com/trending/go', note: 'Community feed', since: 2 },
      { title: 'Last Week in AI', feed: 'https://lastweekin.ai/feed', site: 'https://lastweekin.ai', since: 2 },
      { title: 'TLDR AI', feed: 'https://tldr.tech/api/rss/ai', site: 'https://tldr.tech/ai', since: 2 },
      { title: 'Hacker News best', feed: 'https://hnrss.org/best', site: 'https://news.ycombinator.com/best', since: 2 },
    ],
  },
];

/** Stable id for a catalog source. Resolution may later change the stored url, never the id. */
export const catalogId = (e) => hash(e.key || e.feed || e.site);

/** id → { entry, pack } where the first pack to list a source owns it. */
export const CATALOG_INDEX = new Map();
for (const pack of PACKS) {
  for (const entry of pack.feeds) {
    const id = catalogId(entry);
    if (!CATALOG_INDEX.has(id)) CATALOG_INDEX.set(id, { entry, pack });
  }
}

export function makeFeed(entry, pack) {
  return {
    id: catalogId(entry),
    url: entry.feed || entry.site,
    site: entry.site,
    discover: !entry.feed && !entry.page,
    ...(entry.page ? { kind: 'page' } : {}),
    title: entry.title,
    siteUrl: entry.site,
    hue: hueFor(entry.title),
    folder: pack.name,
    added: Date.now(),
    lastFetched: 0,
    error: null,
    preset: true,
  };
}

export async function addCatalogSource(id) {
  const hit = CATALOG_INDEX.get(id);
  if (!hit) return false;
  if (await db.get('feeds', id)) return false;
  await db.put('feeds', makeFeed(hit.entry, hit.pack));
  return true;
}

/** Offer every catalog source the person has not been offered yet. Removed sources stay removed. */
export async function seedIfNeeded() {
  const { seedVersion, seededPacks } = await chrome.storage.local.get(['seedVersion', 'seededPacks']);
  // Installs from before versioning had the first catalog and recorded packs instead.
  const from = seedVersion ?? (seededPacks?.length ? 1 : 0);
  if (from >= CATALOG_VERSION) return 0;

  let added = 0;
  for (const pack of PACKS) {
    for (const entry of pack.feeds) {
      if ((entry.since || 1) <= from) continue;
      const id = catalogId(entry);
      if (await db.get('feeds', id)) continue;
      // A source listed in several packs keeps the folder of the first pack that lists it.
      await db.put('feeds', makeFeed(entry, CATALOG_INDEX.get(id)?.pack || pack));
      added++;
    }
  }
  // Sources that used to be followed through a feed address, but are really pages with no feed.
  if (from > 0 && from < 3) {
    for (const [id, { entry }] of CATALOG_INDEX) {
      if (!entry.page) continue;
      const cur = await db.get('feeds', id);
      if (cur?.preset && cur.kind !== 'page') {
        await db.put('feeds', { ...cur, kind: 'page', url: entry.site, site: entry.site, siteUrl: entry.site, discover: false, error: null, lastFetched: 0 });
      }
    }
  }
  // Titles of sources that came from the catalog follow the catalog's wording.
  if (from > 0) {
    for (const [id, { entry }] of CATALOG_INDEX) {
      const cur = await db.get('feeds', id);
      if (cur?.preset && cur.title !== entry.title) await db.put('feeds', { ...cur, title: entry.title });
    }
  }
  await chrome.storage.local.set({ seedVersion: CATALOG_VERSION });
  return added;
}
