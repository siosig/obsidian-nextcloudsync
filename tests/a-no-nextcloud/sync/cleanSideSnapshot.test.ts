// specs/044-conflict-clean-snapshot — capture, recovery, and self-heal of the clean-side snapshot.
// The real reconcile-text + node-diff3 run (no mocks), so a same-line text conflict genuinely produces
// markers (clean:false) — the path that overwrites both clean sides and must capture them first.
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { CleanSideStore } from '../../../src/data/CleanSideStore';
import { DEFAULT_SETTINGS, DavSyncSettings, FileState, RemoteFileInfo, SyncSessionSummary } from '../../../src/types';

const enc = new TextEncoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer;
const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);
const DIR = '.obsidian/plugins/nextcloud-sync';

function fakeAdapter(): DataAdapter {
  const files: Record<string, string> = {};
  return {
    read: jest.fn(async (p: string) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; }),
    write: jest.fn(async (p: string, d: string) => { files[p] = d; }),
    exists: jest.fn(async (p: string) => p in files),
    remove: jest.fn(async (p: string) => { delete files[p]; }),
    rename: jest.fn(async (f: string, t: string) => { files[t] = files[f]; delete files[f]; }),
  } as unknown as DataAdapter;
}

function makeSummary(): SyncSessionSummary {
  return { startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
    mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [] };
}

const PATH = 'note.md';

interface HarnessOpts {
  settings?: Partial<DavSyncSettings>;
  base?: string;          // merge base (feature 038) returned by baseStore.get
  local: string;
  remote: string;
  stateFile?: FileState;  // stateDB.getFile(PATH) result (for the sweep/recovery)
}

async function buildHarness(o: HarnessOpts) {
  const cleanSideStore = new CleanSideStore(fakeAdapter(), DIR, 'dev1');
  await cleanSideStore.load();
  const baseStore = { get: jest.fn(() => o.base), set: jest.fn(), delete: jest.fn(), requestSave: jest.fn(), flush: jest.fn(async () => undefined) };

  const atomicWrite = jest.fn(async (_p: string, _d: string) => undefined);
  const atomicWriteBinary = jest.fn(async (_p: string, _d: ArrayBuffer) => undefined);
  const setMtime = jest.fn(async () => undefined);
  const localAdapter = {
    stat: jest.fn(async () => ({ size: enc.encode(o.local).byteLength, mtime: 1000 })),
    read: jest.fn(async () => o.local),
    readBinary: jest.fn(async () => toBuf(o.local)),
    atomicWrite, atomicWriteBinary, setMtime,
  };
  const setFile = jest.fn();
  const stateDB = {
    setFile, getFile: jest.fn(() => o.stateFile), setRemoteRootEtag: jest.fn(),
    save: jest.fn(async () => undefined), requestSave: jest.fn(),
  };
  const upload = jest.fn(async (_client: unknown, _path: string, _data: ArrayBuffer, _mtime: number) => 'uploaded' as const);
  const remoteInfo: RemoteFileInfo = {
    path: PATH, fileId: 'fid-1', checksum: 'rem-checksum', etag: 'etag-1',
    size: enc.encode(o.remote).byteLength, lastModified: 2000,
  };
  const client = {
    downloadFile: jest.fn(async () => toBuf(o.remote)),
    getFiles: jest.fn(async () => [remoteInfo]),
  };

  const engine = new SyncEngine({
    app: {}, settings: { ...DEFAULT_SETTINGS, deviceId: 'dev1', autoMergeFileTypes: ['md'], autoMergeFileStrategy: 'merge', ...o.settings },
    localAdapter, stateDB, baseStore, cleanSideStore,
    statusBar: {}, webdavFactory: {}, pluginDir: DIR, configDir: '.obsidian',
  } as never);
  (engine as unknown as { client: unknown }).client = client;
  (engine as unknown as { features: unknown }).features = { isNextcloud: false };
  (engine as unknown as { uploadStrategy: unknown }).uploadStrategy = { upload };

  const invokeConflict = (base: FileState | undefined = o.stateFile) =>
    (engine as unknown as { handleConflict(p: string, b: FileState | undefined, r: RemoteFileInfo, id: string, t: FileState['idType'], s: SyncSessionSummary): Promise<void> })
      .handleConflict(PATH, base, remoteInfo, 'rem-checksum', 'sha256', makeSummary());

  return { engine, cleanSideStore, atomicWrite, atomicWriteBinary, upload, setFile, client, invokeConflict };
}

describe('[SPEC:CSS-1][SPEC:CSS-12] capture the clean sides on a marker write only', () => {
  it('[SPEC:CSS-1] a same-line text conflict (marker write) captures BOTH clean sides before the overwrite', async () => {
    const h = await buildHarness({ base: 'a\nX\nc\n', local: 'a\nLOCAL\nc\n', remote: 'a\nREMOTE\nc\n' });
    await h.invokeConflict();
    // The write was a marker write (not a clean merge): the overwrite went out as full-file markers.
    expect(h.atomicWrite).toHaveBeenCalled();
    expect(dec(toBuf(h.atomicWrite.mock.calls[0][1] as string))).toContain('<<<<<<< LOCAL');
    // Both CLEAN sides were captured (pre-marker local + remote), not the marker content.
    const snap = h.cleanSideStore.get(PATH);
    expect(snap).toBeDefined();
    expect(snap!.local).toBe('a\nLOCAL\nc\n');
    expect(snap!.remote).toBe('a\nREMOTE\nc\n');
    expect(snap!.local).not.toContain('<<<<<<<');
  });

  it('[SPEC:CSS-12] a clean auto-merge (non-overlapping edits) captures NOTHING', async () => {
    // Distinct lines edited → reconcile merges cleanly (clean:true), no clean side is lost.
    const h = await buildHarness({ base: 'l1\nl2\nl3\n', local: 'L1\nl2\nl3\n', remote: 'l1\nl2\nL3\n' });
    await h.invokeConflict();
    expect(h.cleanSideStore.get(PATH)).toBeUndefined();
  });

  it('[SPEC:CSS-12] a safe-hold (binary) conflict captures NOTHING', async () => {
    const nul = String.fromCharCode(0);
    const h = await buildHarness({ base: `x${nul}y`, local: `l${nul}bin`, remote: `r${nul}bin`,
      stateFile: { path: PATH, localHash: 'lh', remoteId: 'rh', idType: 'sha256', size: 5, mtime: 1000, remoteFileId: 'fid-1', isConflicted: false } });
    await h.invokeConflict();
    expect(h.cleanSideStore.get(PATH)).toBeUndefined();
  });

  it('[SPEC:CSS-12] a deterministic strategy (remote-win, non-merge type) captures NOTHING', async () => {
    const h = await buildHarness({ settings: { autoMergeFileTypes: [], otherFileStrategy: 'remote-win' },
      local: 'local', remote: 'remote' });
    await h.invokeConflict();
    expect(h.cleanSideStore.get(PATH)).toBeUndefined();
  });
});

describe('[SPEC:CSS-2][SPEC:CSS-4][SPEC:CSS-6] recover a real clean side from the snapshot', () => {
  async function withSnapshot() {
    const h = await buildHarness({ local: 'markers-on-disk', remote: 'markers-on-server',
      stateFile: { path: PATH, localHash: 'lh', remoteId: 'rh', idType: 'sha256', size: 5, mtime: 1000, remoteFileId: 'fid-1', isConflicted: true } });
    h.cleanSideStore.set(PATH, { local: 'clean LOCAL', remote: 'clean REMOTE', localMtime: 3000, remoteMtime: 1000, localSize: 11, remoteSize: 12 });
    return h;
  }

  it('[SPEC:CSS-2] applyCleanRemote writes the clean REMOTE to both sides, clears the flag, drops the snapshot', async () => {
    const h = await withSnapshot();
    await h.engine.applyCleanRemote(PATH);
    // Uploaded the clean remote content to the server, and wrote it locally too.
    expect(dec(h.upload.mock.calls[0][2] as ArrayBuffer)).toBe('clean REMOTE');
    expect(dec(h.atomicWriteBinary.mock.calls[0][1] as ArrayBuffer)).toBe('clean REMOTE');
    // Converged, not conflicted, and no marker content anywhere.
    const st = h.setFile.mock.calls.at(-1)![0] as FileState;
    expect(st.isConflicted).toBe(false);
    // Snapshot dropped (no leak).
    expect(h.cleanSideStore.get(PATH)).toBeUndefined();
  });

  it('[SPEC:CSS-2] applyCleanLocal writes the clean LOCAL to both sides and drops the snapshot', async () => {
    const h = await withSnapshot();
    await h.engine.applyCleanLocal(PATH);
    expect(dec(h.upload.mock.calls[0][2] as ArrayBuffer)).toBe('clean LOCAL');
    expect(dec(h.atomicWriteBinary.mock.calls[0][1] as ArrayBuffer)).toBe('clean LOCAL');
    expect(h.cleanSideStore.get(PATH)).toBeUndefined();
  });

  it('[SPEC:CSS-3] cleanSideMetrics returns the captured clean sides metrics (for Latest/Biggest)', async () => {
    const h = await withSnapshot();
    expect(h.engine.cleanSideMetrics(PATH)).toEqual({ localMtime: 3000, remoteMtime: 1000, localSize: 11, remoteSize: 12 });
  });
});

describe('[SPEC:CSS-5] fallback when no snapshot exists', () => {
  it('cleanSideMetrics returns null and applyCleanRemote falls back to a plain remote pull', async () => {
    const h = await buildHarness({ local: 'L', remote: 'R',
      stateFile: { path: PATH, localHash: 'lh', remoteId: 'rem-checksum', idType: 'sha256', size: 1, mtime: 1000, remoteFileId: 'fid-1', isConflicted: false } });
    expect(h.engine.cleanSideMetrics(PATH)).toBeNull();
    await h.engine.applyCleanRemote(PATH); // no snapshot → pullRemoteToLocal (downloads current remote)
    expect(h.atomicWriteBinary).toHaveBeenCalled();
    expect(dec(h.atomicWriteBinary.mock.calls[0][1] as ArrayBuffer)).toBe('R');
  });
});

describe('[SPEC:CSS-7] no user-facing setting is introduced', () => {
  it('DEFAULT_SETTINGS gains no clean-side / snapshot key (internal store only)', () => {
    expect('cleanSideSnapshot' in DEFAULT_SETTINGS).toBe(false);
    expect('conflictSnapshot' in DEFAULT_SETTINGS).toBe(false);
    expect('cleanSideStore' in DEFAULT_SETTINGS).toBe(false);
  });
});

describe('[SPEC:CSS-6][SPEC:CSS-8] self-heal sweep drops snapshots for converged files', () => {
  it('sweepResolvedSnapshots drops a snapshot whose file is no longer conflicted, keeps a still-conflicted one', async () => {
    const conflicted: FileState = { path: 'still.md', localHash: 'lh', remoteId: 'rh', idType: 'sha256', size: 1, mtime: 1, remoteFileId: 'f', isConflicted: true };
    const h = await buildHarness({ local: 'L', remote: 'R' });
    // Two snapshots; stateDB says only 'still.md' is still conflicted.
    h.cleanSideStore.set('gone.md', { local: 'a', remote: 'b', localMtime: 1, remoteMtime: 1, localSize: 1, remoteSize: 1 });
    h.cleanSideStore.set('still.md', { local: 'a', remote: 'b', localMtime: 1, remoteMtime: 1, localSize: 1, remoteSize: 1 });
    (h.engine as unknown as { opts: { stateDB: { getFile: jest.Mock } } }).opts.stateDB.getFile =
      jest.fn((p: string) => (p === 'still.md' ? conflicted : { ...conflicted, path: p, isConflicted: false }));

    (h.engine as unknown as { sweepResolvedSnapshots(): void }).sweepResolvedSnapshots();

    expect(h.cleanSideStore.get('gone.md')).toBeUndefined(); // converged → dropped
    expect(h.cleanSideStore.get('still.md')).toBeDefined();   // still conflicted → kept
    expect(h.cleanSideStore.size()).toBe(1);
  });
});
