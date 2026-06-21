import { SyncHistoryStore } from '../../../src/data/SyncHistoryStore';

/** Minimal in-memory DataAdapter covering the methods SyncHistoryStore uses. */
function makeAdapter() {
  const files = new Map<string, string>();
  return {
    files,
    async exists(p: string) { return files.has(p); },
    async read(p: string) { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v; },
    async write(p: string, data: string) { files.set(p, data); },
    async remove(p: string) { files.delete(p); },
    async rename(from: string, to: string) { files.set(to, files.get(from)!); files.delete(from); },
  };
}

const HOUR = 60 * 60 * 1000;
const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';
const HISTORY_PATH = `${PLUGIN_DIR}/sync-history.json`;

describe('SyncHistoryStore', () => {
  it('record + recent returns entries within 24h, newest first', () => {
    const store = new SyncHistoryStore(makeAdapter() as never, PLUGIN_DIR);
    const now = 1_000_000_000_000;
    store.record('a.md', 'uploaded', now - 3 * HOUR);
    store.record('b.md', 'downloaded', now - 1 * HOUR);
    store.record('c.md', 'deleted', now - 2 * HOUR);

    const recent = store.recent(now);
    expect(recent.map(e => e.path)).toEqual(['b.md', 'c.md', 'a.md']); // newest first
    expect(recent.map(e => e.op)).toEqual(['downloaded', 'deleted', 'uploaded']);
  });

  it('recent drops entries older than the 24h window', () => {
    const store = new SyncHistoryStore(makeAdapter() as never, PLUGIN_DIR);
    const now = 1_000_000_000_000;
    store.record('old.md', 'uploaded', now - 25 * HOUR);
    store.record('fresh.md', 'uploaded', now - 1 * HOUR);

    expect(store.recent(now).map(e => e.path)).toEqual(['fresh.md']);
  });

  it('error entries keep their message; non-errors omit it', () => {
    const store = new SyncHistoryStore(makeAdapter() as never, PLUGIN_DIR);
    const now = 1_000_000_000_000;
    store.record('x.md', 'error', now, 'boom');
    store.record('y.md', 'uploaded', now);

    const [first, second] = store.recent(now);
    // both at `now`; order between equal timestamps is not asserted — find by path
    const err = [first, second].find(e => e.path === 'x.md')!;
    const ok = [first, second].find(e => e.path === 'y.md')!;
    expect(err.message).toBe('boom');
    expect(ok.message).toBeUndefined();
  });

  it('save prunes aged entries before persisting; load reads them back', async () => {
    const adapter = makeAdapter();
    const now = 1_000_000_000_000;
    const a = new SyncHistoryStore(adapter as never, PLUGIN_DIR);
    a.record('old.md', 'uploaded', now - 30 * HOUR);
    a.record('keep.md', 'downloaded', now - 2 * HOUR);
    await a.save(now);

    // Persisted JSON should not contain the aged entry.
    expect(adapter.files.get(HISTORY_PATH)).not.toContain('old.md');

    const b = new SyncHistoryStore(adapter as never, PLUGIN_DIR);
    await b.load(now);
    expect(b.recent(now).map(e => e.path)).toEqual(['keep.md']);
  });

  it('caps stored entries to the max, keeping the newest', async () => {
    const adapter = makeAdapter();
    const now = 1_000_000_000_000;
    const store = new SyncHistoryStore(adapter as never, PLUGIN_DIR, 24 * HOUR, 3); // cap = 3
    // 5 entries within the window at increasing recency
    for (let i = 0; i < 5; i++) store.record(`f${i}.md`, 'uploaded', now - (5 - i) * 60 * 1000);
    await store.save(now);

    const reloaded = new SyncHistoryStore(adapter as never, PLUGIN_DIR, 24 * HOUR, 3);
    await reloaded.load(now);
    const paths = reloaded.recent(now).map(e => e.path);
    expect(paths).toHaveLength(3);
    expect(paths).toEqual(['f4.md', 'f3.md', 'f2.md']); // newest 3 kept
  });

  it('load tolerates a corrupt/missing file (starts empty)', async () => {
    const adapter = makeAdapter();
    const now = 1_000_000_000_000;
    // missing file
    const a = new SyncHistoryStore(adapter as never, PLUGIN_DIR);
    await a.load(now);
    expect(a.recent(now)).toEqual([]);
    // corrupt file
    adapter.files.set(HISTORY_PATH, '{not valid json');
    const b = new SyncHistoryStore(adapter as never, PLUGIN_DIR);
    await b.load(now);
    expect(b.recent(now)).toEqual([]);
  });
});
