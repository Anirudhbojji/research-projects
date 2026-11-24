import { hash } from './util.js';

const DAY = 864e5;

/**
 * Turn a parsed feed, or a parsed page, into the item rows that are new since the last refresh.
 *   feed:   the stored source
 *   parsed: { items } from parseFeed or extractPageItems
 *   opts:   { now, first, known: Set of item ids, isMuted(text), retentionDays }
 */
export function buildItems(feed, parsed, { now, first, known, isMuted, retentionDays }) {
  // Items older than the retention window would only be pruned again, so do not bring them back.
  const oldest = retentionDays > 0 ? now - retentionDays * DAY : 0;

  const entries = parsed.items
    .slice(0, 80)
    .map((it, idx) => {
      const dated = Boolean(it.published);
      // A page without dates is read top to bottom: the first card counts as newest.
      return { it, dated, idx, published: dated ? Math.min(it.published, now) : now - idx * 60e3 };
    })
    .filter((e) => e.published >= oldest)
    .sort((a, b) => b.published - a.published || a.idx - b.idx);

  return entries
    .map(({ it, dated, published }, i) => {
      const muted = isMuted(`${it.title} ${it.summary}`);
      return {
        // The feed id is a prefix of every item id, so one feed can never write over another feed's rows,
        // whatever guid it publishes. The hashed part is unchanged so older libraries re-key in place.
        id: `${feed.id}:${hash(`${feed.id}|${it.guid || it.link || it.title}`)}`,
        feedId: feed.id,
        title: it.title || '(untitled)',
        link: it.link,
        published,
        summary: it.summary,
        html: (it.html || '').slice(0, 200000),
        author: it.author,
        image: it.image,
        media: it.media,
        // A brand new source keeps its newest posts unread and files the rest as read.
        read: muted || (first && (dated ? i >= 3 && now - published > 3 * DAY : i >= 5)),
        hidden: muted,
        starred: false,
      };
    })
    .filter((row) => !known.has(row.id));
}
