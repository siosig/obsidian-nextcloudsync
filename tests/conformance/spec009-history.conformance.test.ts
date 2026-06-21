// Spec-conformance: 009 FR-C2 (sync-history persistence: 24h window + hard cap).
import { SyncHistoryStore } from '../../src/data/SyncHistoryStore';
import { makeFakeAdapter } from './support/fakeAdapter';

const HOUR = 60 * 60 * 1000;

describe('spec 009 — sync history store (FR-C2)', () => {
  it('recent() returns only entries within the 24h window, newest first', () => {
    const s = new SyncHistoryStore(makeFakeAdapter(), 'plugin');
    const now = 100 * HOUR;
    s.record('old.md', 'uploaded', now - 25 * HOUR); // older than 24h → dropped
    s.record('a.md', 'uploaded', now - 1 * HOUR);
    s.record('b.md', 'uploaded', now - 0.5 * HOUR);
    expect(s.recent(now).map((e) => e.path)).toEqual(['b.md', 'a.md']);
  });

  it('save() prunes to the configured max entries, keeping the newest', async () => {
    const s = new SyncHistoryStore(makeFakeAdapter(), 'plugin', 24 * HOUR, 2);
    const now = 10_000;
    s.record('a', 'uploaded', now - 3);
    s.record('b', 'uploaded', now - 2);
    s.record('c', 'uploaded', now - 1);
    await s.save(now);
    const r = s.recent(now);
    expect(r.length).toBe(2);
    expect(r.map((e) => e.path)).toEqual(['c', 'b']);
  });

  it('history persists across reload (atomic write + load)', async () => {
    const a = makeFakeAdapter();
    const now = 10_000;
    const s1 = new SyncHistoryStore(a, 'plugin');
    s1.record('a.md', 'downloaded', now - 100);
    await s1.save(now);
    const s2 = new SyncHistoryStore(a, 'plugin');
    await s2.load(now);
    expect(s2.recent(now).map((e) => e.path)).toEqual(['a.md']);
  });
});
