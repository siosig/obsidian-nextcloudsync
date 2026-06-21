import { StateDB } from '../../../src/data/StateDB';
import { DataAdapter } from 'obsidian';
import { FileState } from '../../../src/types';

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

  // ── P0-B: compact persistence, debounced save, O(1) remoteFileId index, v1 load ──

  it('persists compact JSON (no pretty-print indentation)', async () => {
    const adapter = makeAdapter();
    const db = new StateDB(adapter, PLUGIN_DIR, DEVICE_ID);
    await db.load();
    db.setFile({ path: 'a.md', localHash: 'x', remoteId: 'x', idType: 'sha256', size: 10, mtime: 0, remoteFileId: null, isConflicted: false });
    await db.save();
    const written = (adapter.write as jest.Mock).mock.calls.find(([p]) => String(p).endsWith('.tmp'))?.[1] as string;
    expect(written).toBeDefined();
    // Compact stringify emits no newlines / multi-space indentation.
    expect(written).not.toContain('\n');
    expect(JSON.parse(written).files['a.md'].localHash).toBe('x');
  });

  it('coalesces watch-mode requestSave() calls into a single write, flushed by flush()', async () => {
    const adapter = makeAdapter();
    const db = new StateDB(adapter, PLUGIN_DIR, DEVICE_ID);
    await db.load();
    db.setSyncToken('tok');
    db.requestSave();
    db.requestSave();
    db.requestSave();
    // Debounced: nothing written yet (no real time has elapsed).
    expect(adapter.write).not.toHaveBeenCalled();
    await db.flush();
    // Exactly one coalesced save persisted the state.
    expect((adapter.write as jest.Mock).mock.calls.filter(([p]) => String(p).endsWith('.tmp'))).toHaveLength(1);
    expect(adapter.rename).toHaveBeenCalledTimes(1);
  });

  it('flush() is a no-op (no throw) when no save is pending', async () => {
    const adapter = makeAdapter();
    const db = new StateDB(adapter, PLUGIN_DIR, DEVICE_ID);
    await db.load();
    await expect(db.flush()).resolves.not.toThrow();
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('keeps the remoteFileId index correct across rename and delete', async () => {
    const db = new StateDB(makeAdapter(), PLUGIN_DIR, DEVICE_ID);
    await db.load();
    db.setFile({ path: 'old.md', localHash: 'h', remoteId: 'r', idType: 'sha256', size: 5, mtime: 0, remoteFileId: 'fid-1', isConflicted: false });
    expect(db.getFileByRemoteId('fid-1')?.path).toBe('old.md');
    // Rename = delete old + set new (same fileId, new path).
    db.deleteFile('old.md');
    expect(db.getFileByRemoteId('fid-1')).toBeUndefined();
    db.setFile({ path: 'new.md', localHash: 'h', remoteId: 'r', idType: 'sha256', size: 5, mtime: 0, remoteFileId: 'fid-1', isConflicted: false });
    expect(db.getFileByRemoteId('fid-1')?.path).toBe('new.md');
    // Changing a path's fileId drops the stale mapping.
    db.setFile({ path: 'new.md', localHash: 'h', remoteId: 'r', idType: 'sha256', size: 5, mtime: 0, remoteFileId: 'fid-2', isConflicted: false });
    expect(db.getFileByRemoteId('fid-1')).toBeUndefined();
    expect(db.getFileByRemoteId('fid-2')?.path).toBe('new.md');
  });

  it('rebuilds the remoteFileId index on load (survives reload)', async () => {
    const adapter = makeAdapter();
    const db = new StateDB(adapter, PLUGIN_DIR, DEVICE_ID);
    await db.load();
    db.setFile({ path: 'x.md', localHash: 'h', remoteId: 'r', idType: 'sha256', size: 5, mtime: 0, remoteFileId: 'fid-9', isConflicted: false });
    await db.save();
    const db2 = new StateDB(adapter, PLUGIN_DIR, DEVICE_ID);
    await db2.load();
    expect(db2.getFileByRemoteId('fid-9')?.path).toBe('x.md');
  });

  // ── 017: Vault index reset (maintenance) ──

  it('reset() clears all tracked files and the sync token, preserves deviceId, and persists', async () => {
    const adapter = makeAdapter();
    const db = new StateDB(adapter, PLUGIN_DIR, DEVICE_ID);
    await db.load();
    db.setSyncToken('tok123');
    db.setLastSyncTime(999);
    db.setFile({ path: 'a.md', localHash: 'x', remoteId: 'x', idType: 'sha256', size: 10, mtime: 0, remoteFileId: 'fid-1', isConflicted: false });
    db.setFile({ path: 'b.md', localHash: 'y', remoteId: 'y', idType: 'sha256', size: 10, mtime: 0, remoteFileId: 'fid-2', isConflicted: true });

    await db.reset();

    // In-memory state is the first-install empty state, deviceId preserved.
    expect(db.getAllFiles()).toHaveLength(0);
    expect(db.getSyncToken()).toBeNull();
    expect(db.getLastSyncTime()).toBe(0);
    expect(db.getDeviceId()).toBe(DEVICE_ID);
    // The remoteFileId reverse index is emptied too.
    expect(db.getFileByRemoteId('fid-1')).toBeUndefined();
    expect(db.getFileByRemoteId('fid-2')).toBeUndefined();
    // Persisted: a fresh load yields the empty state.
    const reloaded = new StateDB(adapter, PLUGIN_DIR, DEVICE_ID);
    await reloaded.load();
    expect(reloaded.getAllFiles()).toHaveLength(0);
    expect(reloaded.getSyncToken()).toBeNull();
    expect(reloaded.getDeviceId()).toBe(DEVICE_ID);
  });

  it('reset() cancels a pending debounced save so it cannot resurrect the old state', async () => {
    const adapter = makeAdapter();
    const db = new StateDB(adapter, PLUGIN_DIR, DEVICE_ID);
    await db.load();
    db.setSyncToken('stale');
    db.requestSave(); // schedule a debounced write of the stale state
    await db.reset();
    await db.flush(); // any leftover pending timer would write here
    const raw = await adapter.read(`${PLUGIN_DIR}/state-${DEVICE_ID}.json`);
    const persisted = JSON.parse(raw);
    expect(persisted.syncToken).toBeNull();
    expect(persisted.files).toEqual({});
  });

  it('static resetFile() overwrites a non-empty on-disk state with the canonical empty state', async () => {
    const existing = {
      deviceId: DEVICE_ID, lastSyncTime: 42, syncToken: 'tok',
      files: { 'n.md': { path: 'n.md', localHash: 'a', remoteId: 'b', idType: 'sha256', size: 3, mtime: 1, remoteFileId: 'fid', isConflicted: false } },
    };
    const adapter = makeAdapter({ [`${PLUGIN_DIR}/state-${DEVICE_ID}.json`]: JSON.stringify(existing) });

    await StateDB.resetFile(adapter, PLUGIN_DIR, DEVICE_ID);

    const db = new StateDB(adapter, PLUGIN_DIR, DEVICE_ID);
    await db.load();
    expect(db.getAllFiles()).toHaveLength(0);
    expect(db.getSyncToken()).toBeNull();
    expect(db.getLastSyncTime()).toBe(0);
    expect(db.getDeviceId()).toBe(DEVICE_ID);
  });

  it('static resetFile() works when no state file exists yet', async () => {
    const adapter = makeAdapter();
    await expect(StateDB.resetFile(adapter, PLUGIN_DIR, DEVICE_ID)).resolves.not.toThrow();
    const db = new StateDB(adapter, PLUGIN_DIR, DEVICE_ID);
    await db.load();
    expect(db.getAllFiles()).toHaveLength(0);
    expect(db.getSyncToken()).toBeNull();
  });

  it('loads a v1 state file lacking the new signature fields without error', async () => {
    // No localMtime/localSize/remoteMtime — represents pre-upgrade state.
    const v1 = {
      deviceId: DEVICE_ID, lastSyncTime: 5, syncToken: null,
      files: { 'n.md': { path: 'n.md', localHash: 'a', remoteId: 'b', idType: 'sha256', size: 3, mtime: 1, remoteFileId: 'fid', isConflicted: false } },
    };
    const adapter = makeAdapter({ [`${PLUGIN_DIR}/state-${DEVICE_ID}.json`]: JSON.stringify(v1) });
    const db = new StateDB(adapter, PLUGIN_DIR, DEVICE_ID);
    await expect(db.load()).resolves.not.toThrow();
    const f = db.getFile('n.md');
    expect(f?.localMtime).toBeUndefined();
    expect(db.getFileByRemoteId('fid')?.path).toBe('n.md');
  });
});
