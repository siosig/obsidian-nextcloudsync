// [SPEC:WSF-10] specs/064-watch-single-file-conflict/contracts/watch-single-file-sync.md (C-7)
//
// Feature 064 routed the watch-mode single-file path through the full classification, so it can now
// WRITE locally (a download, or a merge result) where it previously only ever PUT. That write lands
// in the vault and fires the same `modify` event the watcher listens to — if it were not recognised
// as our own, the watcher would schedule another single-file sync, which writes again: a PUT → event
// → PUT loop that never settles.
//
// main.ts suppresses it with `isOwnSyncEvent = isSyncTmpPath(path) || localAdapter.shouldIgnore(path)`.
// That guard is only as good as the ignore registration performed by the write itself, which is what
// these tests pin down: every local write path the watch flow can take marks the path first.
import { DataAdapter } from 'obsidian';
import { LocalAdapter, isSyncTmpPath } from '../../../src/data/LocalAdapter';

function makeAdapter() {
  const files = new Map<string, string | ArrayBuffer>();
  const adapter = {
    mkdir: jest.fn(async () => undefined),
    write: jest.fn(async (p: string, d: string) => { files.set(p, d); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files.set(p, d); }),
    exists: jest.fn(async (p: string) => files.has(p)),
    remove: jest.fn(async (p: string) => { files.delete(p); }),
    rename: jest.fn(async (from: string, to: string) => {
      const v = files.get(from);
      if (v === undefined) throw new Error(`missing ${from}`);
      files.set(to, v);
      files.delete(from);
    }),
    stat: jest.fn(async (p: string) => {
      const v = files.get(p);
      if (v === undefined) return null;
      return { size: typeof v === 'string' ? v.length : v.byteLength, mtime: 0 };
    }),
  } as unknown as DataAdapter;
  return { adapter, files };
}

/** The exact predicate main.ts applies to every vault event before propagating it. */
const isOwnSyncEvent = (local: LocalAdapter, path: string): boolean =>
  isSyncTmpPath(path) || local.shouldIgnore(path);

describe('[WSF-10] a write made by the watch path never triggers another single-file sync', () => {
  it('atomicWrite (merge result / conflict markers) marks the target as our own write', async () => {
    const { adapter } = makeAdapter();
    const local = new LocalAdapter(adapter);
    const path = 'Notes/note.md';

    expect(isOwnSyncEvent(local, path)).toBe(false); // a user edit is NOT suppressed

    await local.atomicWrite(path, 'merged body\n');

    expect(isOwnSyncEvent(local, path)).toBe(true);
  });

  it('atomicWriteBinary (download) marks the target as our own write', async () => {
    const { adapter } = makeAdapter();
    const local = new LocalAdapter(adapter);
    const path = 'attachments/img.png';

    await local.atomicWriteBinary(path, new ArrayBuffer(8));

    expect(isOwnSyncEvent(local, path)).toBe(true);
  });

  it('the intermediate tmp file is suppressed too, by name alone', async () => {
    const { adapter, files } = makeAdapter();
    const local = new LocalAdapter(adapter);
    await local.atomicWrite('Notes/note.md', 'body\n');

    // The tmp path only exists transiently, so the watcher may see its create/rename events after the
    // ignore entry has already expired. isSyncTmpPath is the name-based backstop for exactly that.
    const rename = adapter.rename as unknown as jest.Mock;
    const tmpSeen = rename.mock.calls.map(([from]) => from as string);
    expect(tmpSeen).toHaveLength(1);
    expect(isSyncTmpPath(tmpSeen[0])).toBe(true);
    expect(files.has(tmpSeen[0])).toBe(false); // renamed away, nothing left behind
  });

  it('an unrelated path is not suppressed — the guard stays narrow', async () => {
    const { adapter } = makeAdapter();
    const local = new LocalAdapter(adapter);

    await local.atomicWrite('Notes/synced.md', 'body\n');

    expect(isOwnSyncEvent(local, 'Notes/typed-by-user.md')).toBe(false);
  });
});
