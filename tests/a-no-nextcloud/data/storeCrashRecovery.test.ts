// G4-2 regression: each store's doSave() does remove(path) then rename(tmp, path) with no
// transaction — a crash (power loss / mobile OS kill) between the two leaves `path` absent while the
// good, fully-written data still sits at `tmp`. Before the fix, load() only checked exists(path) and
// silently treated this as "first run = empty state", discarding the persisted data. load() must
// recover from a surviving tmp file instead.
import { DataAdapter } from 'obsidian';
import { StateDB } from '../../../src/data/StateDB';
import { CleanSideStore } from '../../../src/data/CleanSideStore';
import { MergeBaseStore } from '../../../src/data/MergeBaseStore';
import { SyncHistoryStore } from '../../../src/data/SyncHistoryStore';
import { FileState, CleanSideSnapshot } from '../../../src/types';

function makeAdapter(seed: Record<string, string> = {}): DataAdapter & { files: Record<string, string> } {
  const files = { ...seed };
  return {
    files,
    read: jest.fn(async (p: string) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; }),
    write: jest.fn(async (p: string, d: string) => { files[p] = d; }),
    exists: jest.fn(async (p: string) => p in files),
    remove: jest.fn(async (p: string) => { delete files[p]; }),
    rename: jest.fn(async (from: string, to: string) => { files[to] = files[from]; delete files[from]; }),
  } as unknown as DataAdapter & { files: Record<string, string> };
}

const DIR = '.obsidian/plugins/nextcloud-sync';
const DEVICE_ID = 'dev1';

describe('[G4-2] load() recovers from a surviving tmp file when the primary save crashed mid remove→rename', () => {
  it('StateDB.load() recovers persisted state from tmp when statePath is absent', async () => {
    const statePath = `${DIR}/state-${DEVICE_ID}.json`;
    const tmpPath = `${statePath}.tmp`;
    const goodState = {
      deviceId: DEVICE_ID, lastSyncTime: 555, syncToken: 'crash-survivor',
      files: {
        'n.md': {
          path: 'n.md', localHash: 'h', remoteId: 'r', idType: 'sha256', size: 3, mtime: 1,
          remoteFileId: 'fid-1', isConflicted: false,
        } as FileState,
      },
    };
    // Only the tmp file survives — statePath is absent, as it would be right after remove() but
    // before rename() completed.
    const adapter = makeAdapter({ [tmpPath]: JSON.stringify(goodState) });

    const db = new StateDB(adapter, DIR, DEVICE_ID);
    await db.load();

    expect(db.getSyncToken()).toBe('crash-survivor');
    expect(db.getFile('n.md')?.localHash).toBe('h');
    expect(db.getFileByRemoteId('fid-1')?.path).toBe('n.md'); // index rebuilt from recovered state
    // Adopted: the primary path now holds the recovered data and the tmp is gone.
    expect(adapter.files[statePath]).toBeDefined();
    expect(tmpPath in adapter.files).toBe(false);
  });

  it('StateDB.load() still starts empty when neither statePath nor tmp exist (genuine first run)', async () => {
    const adapter = makeAdapter();
    const db = new StateDB(adapter, DIR, DEVICE_ID);
    await db.load();
    expect(db.getAllFiles()).toHaveLength(0);
    expect(db.getSyncToken()).toBeNull();
  });

  it('CleanSideStore.load() recovers snapshots from tmp when storePath is absent', async () => {
    const storePath = `${DIR}/conflict-clean-${DEVICE_ID}.json`;
    const tmpPath = `${storePath}.tmp`;
    const snap: CleanSideSnapshot = {
      local: 'LOCAL body', remote: 'REMOTE body',
      localMtime: 2000, remoteMtime: 1000, localSize: 10, remoteSize: 11,
    };
    const adapter = makeAdapter({ [tmpPath]: JSON.stringify({ 'note.md': snap }) });

    const store = new CleanSideStore(adapter, DIR, DEVICE_ID);
    await store.load();

    expect(store.get('note.md')).toEqual(snap);
    expect(adapter.files[storePath]).toBeDefined();
    expect(tmpPath in adapter.files).toBe(false);
  });

  it('MergeBaseStore.load() recovers bases from tmp when storePath is absent', async () => {
    const storePath = `${DIR}/merge-base-${DEVICE_ID}.json`;
    const tmpPath = `${storePath}.tmp`;
    const adapter = makeAdapter({ [tmpPath]: JSON.stringify({ 'note.md': 'hello\nworld' }) });

    const store = new MergeBaseStore(adapter, DIR, DEVICE_ID);
    await store.load();

    expect(store.get('note.md')).toBe('hello\nworld');
    expect(adapter.files[storePath]).toBeDefined();
    expect(tmpPath in adapter.files).toBe(false);
  });

  it('SyncHistoryStore.load() recovers entries from tmp when filePath is absent', async () => {
    const filePath = `${DIR}/sync-history.json`;
    const tmpPath = `${filePath}.tmp`;
    const now = 1_000_000_000_000;
    const entries = [{ path: 'a.md', op: 'uploaded', at: now - 1000 }];
    const adapter = makeAdapter({ [tmpPath]: JSON.stringify(entries) });

    const store = new SyncHistoryStore(adapter, DIR);
    await store.load(now);

    expect(store.recent(now).map(e => e.path)).toEqual(['a.md']);
    expect(adapter.files[filePath]).toBeDefined();
    expect(tmpPath in adapter.files).toBe(false);
  });
});
