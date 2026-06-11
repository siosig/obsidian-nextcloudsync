import { StateDB } from '../../src/data/StateDB';
import { DataAdapter } from 'obsidian';
import { FileState } from '../../src/types';

function makeAdapter(files: Record<string, string> = {}): DataAdapter {
  const store = { ...files };
  return {
    read: jest.fn(async (p: string) => store[p] ?? ''),
    write: jest.fn(async (p: string, d: string) => { store[p] = d; }),
    readBinary: jest.fn(),
    writeBinary: jest.fn(),
    exists: jest.fn(async (p: string) => p in store),
    remove: jest.fn(async (p: string) => { delete store[p]; }),
    rename: jest.fn(async (from: string, to: string) => { store[to] = store[from]; delete store[from]; }),
    stat: jest.fn(),
    list: jest.fn(),
  } as unknown as DataAdapter;
}

const PLUGIN_DIR = '.obsidian/plugins/obsidian-nextcloudsync';
const DEVICE_ID = 'test-device-001';

describe('StateDB', () => {
  it('starts with empty state when no file exists', async () => {
    const db = new StateDB(makeAdapter(), PLUGIN_DIR, DEVICE_ID);
    await db.load();
    expect(db.getAllFiles()).toHaveLength(0);
    expect(db.getSyncToken()).toBeNull();
  });

  it('loads persisted state from JSON', async () => {
    const existingState = {
      deviceId: DEVICE_ID,
      lastSyncTime: 1000,
      syncToken: 'tok123',
      files: {
        'Notes/todo.md': {
          path: 'Notes/todo.md',
          localHash: 'abc',
          remoteId: 'def',
          idType: 'sha256',
          size: 100,
          mtime: 999,
          remoteFileId: 'fileid-1',
          isConflicted: false,
        } as FileState,
      },
    };
    const adapter = makeAdapter({
      [`${PLUGIN_DIR}/state-${DEVICE_ID}.json`]: JSON.stringify(existingState),
    });
    const db = new StateDB(adapter, PLUGIN_DIR, DEVICE_ID);
    await db.load();
    expect(db.getSyncToken()).toBe('tok123');
    expect(db.getFile('Notes/todo.md')?.localHash).toBe('abc');
  });

  it('atomically saves state (tmp → rename)', async () => {
    const adapter = makeAdapter();
    const db = new StateDB(adapter, PLUGIN_DIR, DEVICE_ID);
    await db.load();
    db.setSyncToken('newtoken');
    await db.save();
    // write was called for tmp file
    expect(adapter.write).toHaveBeenCalledWith(
      expect.stringContaining('.tmp'),
      expect.stringContaining('newtoken'),
    );
    // rename was called
    expect(adapter.rename).toHaveBeenCalled();
  });

  it('handles corrupted JSON gracefully', async () => {
    const adapter = makeAdapter({
      [`${PLUGIN_DIR}/state-${DEVICE_ID}.json`]: 'INVALID JSON {{{',
    });
    const db = new StateDB(adapter, PLUGIN_DIR, DEVICE_ID);
    await expect(db.load()).resolves.not.toThrow();
    expect(db.getAllFiles()).toHaveLength(0);
  });

  it('counts conflicted files', async () => {
    const db = new StateDB(makeAdapter(), PLUGIN_DIR, DEVICE_ID);
    await db.load();
    db.setFile({ path: 'a.md', localHash: 'x', remoteId: 'x', idType: 'sha256', size: 10, mtime: 0, remoteFileId: null, isConflicted: true });
    db.setFile({ path: 'b.md', localHash: 'y', remoteId: 'y', idType: 'sha256', size: 10, mtime: 0, remoteFileId: null, isConflicted: false });
    expect(db.countConflicted()).toBe(1);
  });

  it('serializes concurrent saves (no ENOENT from the exists→remove→rename race)', async () => {
    // Strict adapter: remove/rename throw ENOENT like the real filesystem when the
    // target is missing — this is what interleaved saves used to trip over.
    const store: Record<string, string> = {};
    const strictAdapter = {
      read: jest.fn(async (p: string) => store[p] ?? ''),
      write: jest.fn(async (p: string, d: string) => {
        await Promise.resolve(); // yield so concurrent saves can interleave
        store[p] = d;
      }),
      exists: jest.fn(async (p: string) => p in store),
      remove: jest.fn(async (p: string) => {
        await Promise.resolve();
        if (!(p in store)) throw new Error(`ENOENT: no such file or directory, unlink '${p}'`);
        delete store[p];
      }),
      rename: jest.fn(async (from: string, to: string) => {
        await Promise.resolve();
        if (!(from in store)) throw new Error(`ENOENT: no such file or directory, rename '${from}'`);
        store[to] = store[from];
        delete store[from];
      }),
    } as unknown as DataAdapter;

    const db = new StateDB(strictAdapter, PLUGIN_DIR, DEVICE_ID);
    await db.load();
    db.setSyncToken('tok');

    // Watch-mode storm: many single-file ops saving at once alongside a full sync.
    await expect(Promise.all([db.save(), db.save(), db.save(), db.save(), db.save()]))
      .resolves.not.toThrow();
    expect(store[`${PLUGIN_DIR}/state-${DEVICE_ID}.json`]).toContain('tok');
    expect(`${PLUGIN_DIR}/state-${DEVICE_ID}.json.tmp` in store).toBe(false);
  });

  it('finds file by remoteFileId', async () => {
    const db = new StateDB(makeAdapter(), PLUGIN_DIR, DEVICE_ID);
    await db.load();
    db.setFile({ path: 'notes.md', localHash: 'h', remoteId: 'r', idType: 'etag', size: 5, mtime: 0, remoteFileId: 'fileid-99', isConflicted: false });
    expect(db.getFileByRemoteId('fileid-99')?.path).toBe('notes.md');
    expect(db.getFileByRemoteId('nonexistent')).toBeUndefined();
  });
});
