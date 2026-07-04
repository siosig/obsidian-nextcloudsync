// [SPEC:CSS-10][SPEC:CSS-13] specs/044-conflict-clean-snapshot — CleanSideStore persistence.
// Captures the two clean sides of a marker-conflicted note in its own per-device file so
// force-resolution can recover a real clean version. Mirrors the MergeBaseStore persistence shape.
import { DataAdapter } from 'obsidian';
import { CleanSideStore } from '../../../src/data/CleanSideStore';
import { CleanSideSnapshot } from '../../../src/types';

function fakeAdapter(seed: Record<string, string> = {}): DataAdapter & { files: Record<string, string> } {
  const files = { ...seed };
  return {
    files,
    read: jest.fn(async (p: string) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; }),
    write: jest.fn(async (p: string, d: string) => { files[p] = d; }),
    exists: jest.fn(async (p: string) => p in files),
    remove: jest.fn(async (p: string) => { delete files[p]; }),
    rename: jest.fn(async (f: string, t: string) => { files[t] = files[f]; delete files[f]; }),
  } as unknown as DataAdapter & { files: Record<string, string> };
}

const DIR = '.obsidian/plugins/nextcloud-sync';
const STORE = `${DIR}/conflict-clean-dev1.json`;

const snap = (over: Partial<CleanSideSnapshot> = {}): CleanSideSnapshot => ({
  local: 'LOCAL body', remote: 'REMOTE body',
  localMtime: 2000, remoteMtime: 1000, localSize: 10, remoteSize: 11, ...over,
});

describe('[SPEC:CSS-10] CleanSideStore persistence round-trip', () => {
  it('set → save → load (fresh instance) → get returns the snapshot with both clean sides', async () => {
    const adapter = fakeAdapter();
    const a = new CleanSideStore(adapter, DIR, 'dev1');
    await a.load();
    a.set('note.md', snap({ local: 'my edit', remote: 'their edit' }));
    await a.save();
    expect(adapter.files[STORE]).toBeDefined(); // persisted via tmp→rename (survives restart)

    const b = new CleanSideStore(adapter, DIR, 'dev1');
    await b.load();
    expect(b.get('note.md')).toEqual(snap({ local: 'my edit', remote: 'their edit' }));
  });

  it('delete removes the snapshot and persists the removal; size/paths reflect it', async () => {
    const adapter = fakeAdapter();
    const a = new CleanSideStore(adapter, DIR, 'dev1');
    await a.load();
    a.set('a.md', snap()); a.set('b.md', snap());
    expect(a.size()).toBe(2);
    expect(a.paths().sort()).toEqual(['a.md', 'b.md']);
    a.delete('a.md');
    await a.save();

    const b = new CleanSideStore(adapter, DIR, 'dev1');
    await b.load();
    expect(b.get('a.md')).toBeUndefined();
    expect(b.get('b.md')).toEqual(snap());
    expect(b.size()).toBe(1);
  });
});

describe('[SPEC:CSS-13] CleanSideStore robustness', () => {
  it('persists atomically via tmp→rename (no lingering tmp file after save)', async () => {
    const adapter = fakeAdapter();
    const s = new CleanSideStore(adapter, DIR, 'dev1');
    await s.load();
    s.set('n.md', snap());
    await s.save();
    expect(adapter.files[STORE]).toBeDefined();
    expect(adapter.files[`${STORE}.tmp`]).toBeUndefined(); // tmp renamed away, none left behind
  });

  it('get returns undefined for an unknown path; a corrupt file loads empty (self-healing)', async () => {
    const adapter = fakeAdapter({ [STORE]: '{ not json' });
    const s = new CleanSideStore(adapter, DIR, 'dev1');
    await s.load(); // must not throw
    expect(s.get('whatever.md')).toBeUndefined();
    expect(s.size()).toBe(0);
  });

  it('flush with no pending debounced save resolves quietly', async () => {
    const s = new CleanSideStore(fakeAdapter(), DIR, 'dev1');
    await s.load();
    await expect(s.flush()).resolves.toBeUndefined();
  });

  it('[SPEC:CSS-11] a second capture for the same path overwrites with the most recent clean sides', async () => {
    const s = new CleanSideStore(fakeAdapter(), DIR, 'dev1');
    await s.load();
    s.set('n.md', snap({ local: 'round1 local', remote: 'round1 remote' }));
    s.set('n.md', snap({ local: 'round2 local', remote: 'round2 remote' }));
    expect(s.get('n.md')).toEqual(snap({ local: 'round2 local', remote: 'round2 remote' }));
    expect(s.size()).toBe(1); // still one entry, not accumulated
  });
});
