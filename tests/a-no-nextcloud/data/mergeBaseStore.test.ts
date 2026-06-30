// [SPEC:MB-12] specs/038-merge-base-store — MergeBaseStore persistence (feature 038).
// Stores the last-synced body per Auto Merge File as the 3-way merge base, in its own file.
import { DataAdapter } from 'obsidian';
import { MergeBaseStore } from '../../../src/data/MergeBaseStore';

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
const STORE = `${DIR}/merge-base-dev1.json`;

describe('[SPEC:MB-12] MergeBaseStore persistence round-trip', () => {
  it('set → save → load (fresh instance) → get returns the body', async () => {
    const adapter = fakeAdapter();
    const a = new MergeBaseStore(adapter, DIR, 'dev1');
    await a.load();
    a.set('note.md', 'hello\nworld');
    await a.save();
    expect(adapter.files[STORE]).toBeDefined(); // persisted via tmp→rename

    const b = new MergeBaseStore(adapter, DIR, 'dev1');
    await b.load();
    expect(b.get('note.md')).toBe('hello\nworld');
  });

  it('delete removes the base and persists the removal', async () => {
    const adapter = fakeAdapter();
    const a = new MergeBaseStore(adapter, DIR, 'dev1');
    await a.load();
    a.set('a.md', 'A'); a.set('b.md', 'B');
    a.delete('a.md');
    await a.save();

    const b = new MergeBaseStore(adapter, DIR, 'dev1');
    await b.load();
    expect(b.get('a.md')).toBeUndefined();
    expect(b.get('b.md')).toBe('B');
  });

  it('get returns undefined for an unknown path; corrupt file loads empty (self-healing)', async () => {
    const adapter = fakeAdapter({ [STORE]: '{ not json' });
    const s = new MergeBaseStore(adapter, DIR, 'dev1');
    await s.load(); // must not throw
    expect(s.get('whatever.md')).toBeUndefined();
  });
});
