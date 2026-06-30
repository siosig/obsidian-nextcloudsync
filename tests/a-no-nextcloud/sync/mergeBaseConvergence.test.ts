// [SPEC:MB-5..MB-11] specs/038-merge-base-store — the merge base is recorded at every convergence
// point and dropped on deletion, only for Auto Merge File types (feature 038).
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { DEFAULT_SETTINGS, FileState, RemoteFileInfo, SyncSessionSummary } from '../../../src/types';

const enc = new TextEncoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer;
const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';

function makeStateAdapter(): DataAdapter {
  const store: Record<string, string> = {};
  return {
    read: jest.fn(async (p: string) => store[p] ?? ''),
    write: jest.fn(async (p: string, d: string) => { store[p] = d; }),
    exists: jest.fn(async (p: string) => p in store),
    remove: jest.fn(async (p: string) => { delete store[p]; }),
    rename: jest.fn(async (f: string, t: string) => { store[t] = store[f]; delete store[f]; }),
    stat: jest.fn(), list: jest.fn(), readBinary: jest.fn(), writeBinary: jest.fn(),
  } as unknown as DataAdapter;
}

function makeSummary(): SyncSessionSummary {
  return { startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
    mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [] };
}

function baseSpy() {
  const map = new Map<string, string>();
  return {
    get: jest.fn((p: string) => map.get(p)),
    set: jest.fn((p: string, b: string) => { map.set(p, b); }),
    delete: jest.fn((p: string) => { map.delete(p); }),
    requestSave: jest.fn(),
    flush: jest.fn(async () => undefined),
  };
}

const remoteOf = (path: string, size: number, over: Partial<RemoteFileInfo> = {}): RemoteFileInfo =>
  ({ path, fileId: 'f', checksum: null, etag: 'e', size, lastModified: 0, ...over });

async function buildEngine(localAdapter: Record<string, unknown>, client: Record<string, unknown>) {
  const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
  await stateDB.load();
  const baseStore = baseSpy();
  const engine = new SyncEngine({
    app: {}, settings: { ...DEFAULT_SETTINGS, autoMergeFileTypes: ['md'] },
    localAdapter, stateDB, baseStore, statusBar: {}, webdavFactory: {},
    pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);
  (engine as unknown as { client: unknown }).client = client;
  (engine as unknown as { uploadStrategy: unknown }).uploadStrategy = { upload: jest.fn(async () => 'uploaded' as const) };
  return { engine, baseStore, stateDB };
}

const callDownload = (e: SyncEngine, r: RemoteFileInfo) =>
  (e as unknown as { downloadFile: (r: RemoteFileInfo, id: string, t: string, s: SyncSessionSummary) => Promise<void> })
    .downloadFile(r, 'e', 'etag', makeSummary());
const callUpload = (e: SyncEngine, path: string, r: RemoteFileInfo) =>
  (e as unknown as { uploadFile: (p: string, h: string, id: string, t: string, r: RemoteFileInfo, s: SyncSessionSummary) => Promise<void> })
    .uploadFile(path, 'lh', 'e', 'etag', r, makeSummary());

describe('[SPEC:MB-5] download records base (Auto Merge File text)', () => {
  it('stores the downloaded body as base for a .md file', async () => {
    const localAdapter = { atomicWriteBinary: jest.fn(), setMtime: jest.fn(), stat: jest.fn(async () => ({ size: 5, mtime: 0 })) };
    const client = { downloadFile: jest.fn(async () => toBuf('hello')) };
    const { engine, baseStore } = await buildEngine(localAdapter, client);
    await callDownload(engine, remoteOf('note.md', 5));
    expect(baseStore.set).toHaveBeenCalledWith('note.md', 'hello');
  });
});

describe('[SPEC:MB-11] download does NOT record base for non-Auto-Merge files', () => {
  it('skips base for a .bin file', async () => {
    const localAdapter = { atomicWriteBinary: jest.fn(), setMtime: jest.fn(), stat: jest.fn(async () => ({ size: 3, mtime: 0 })) };
    const client = { downloadFile: jest.fn(async () => toBuf('bin')) };
    const { engine, baseStore } = await buildEngine(localAdapter, client);
    await callDownload(engine, remoteOf('image.bin', 3));
    expect(baseStore.set).not.toHaveBeenCalled();
  });
});

describe('[SPEC:MB-6] upload records base', () => {
  it('stores the uploaded local body as base for a .md file', async () => {
    const localAdapter = {
      stat: jest.fn(async () => ({ size: 5, mtime: 0 })),
      readBinary: jest.fn(async () => toBuf('world')),
    };
    const { engine, baseStore } = await buildEngine(localAdapter, {});
    await callUpload(engine, 'note.md', remoteOf('note.md', 5));
    expect(baseStore.set).toHaveBeenCalledWith('note.md', 'world');
  });
});

describe('[SPEC:MB-8] prefer-local / prefer-remote record base', () => {
  it('prefer-local stores the local body', async () => {
    const localAdapter = {
      stat: jest.fn(async () => ({ size: 4, mtime: 0 })),
      readBinary: jest.fn(async () => toBuf('LOCL')),
    };
    const { engine, baseStore } = await buildEngine(localAdapter, {});
    await (engine as unknown as { resolveByPreferLocal: (p: string, r: RemoteFileInfo, s: SyncSessionSummary) => Promise<void> })
      .resolveByPreferLocal('note.md', remoteOf('note.md', 4), makeSummary());
    expect(baseStore.set).toHaveBeenCalledWith('note.md', 'LOCL');
  });

  it('prefer-remote stores the remote body', async () => {
    const localAdapter = { atomicWriteBinary: jest.fn(), setMtime: jest.fn(), stat: jest.fn(async () => ({ size: 4, mtime: 0 })) };
    const { engine, baseStore } = await buildEngine(localAdapter, {});
    await (engine as unknown as { resolveByPreferRemote: (p: string, r: RemoteFileInfo, d: ArrayBuffer, id: string, t: string, s: SyncSessionSummary) => Promise<void> })
      .resolveByPreferRemote('note.md', remoteOf('note.md', 4), toBuf('REMT'), 'e', 'etag', makeSummary());
    expect(baseStore.set).toHaveBeenCalledWith('note.md', 'REMT');
  });
});

describe('[SPEC:MB-7] clean merge records base; markers do not', () => {
  function mergeAdapter(body: string) {
    return {
      atomicWrite: jest.fn(async () => undefined),
      setMtime: jest.fn(async () => undefined),
      readBinary: jest.fn(async () => toBuf(body)),
      stat: jest.fn(async () => ({ size: body.length, mtime: 0 })),
    };
  }
  const callWrite = (e: SyncEngine, content: string, clean: boolean) =>
    (e as unknown as { resolveByWrite: (p: string, c: string, cl: boolean, r: RemoteFileInfo, id: string, t: string, m: number, s: SyncSessionSummary) => Promise<void> })
      .resolveByWrite('note.md', content, clean, remoteOf('note.md', content.length), 'e', 'etag', 0, makeSummary());

  it('clean merge that reaches the server records the merged body as base', async () => {
    const { engine, baseStore } = await buildEngine(mergeAdapter('MERGED'), {});
    await callWrite(engine, 'MERGED', true);
    expect(baseStore.set).toHaveBeenCalledWith('note.md', 'MERGED');
  });

  it('a marker write (not clean) does NOT record a base', async () => {
    const { engine, baseStore } = await buildEngine(mergeAdapter('<<<<<<< markers'), {});
    await callWrite(engine, '<<<<<<< markers', false);
    expect(baseStore.set).not.toHaveBeenCalled();
  });
});

describe('[SPEC:MB-14] no new user setting introduced', () => {
  it('DEFAULT_SETTINGS gains no merge-base key (internal store only)', () => {
    expect('mergeBase' in DEFAULT_SETTINGS).toBe(false);
    expect('mergeBaseStore' in DEFAULT_SETTINGS).toBe(false);
  });
});

describe('[SPEC:MB-10] deletion drops the base', () => {
  it('applyLocalDeletion (genuine local deletion) drops the base', async () => {
    const localAdapter = { stat: jest.fn() };
    const client = { deleteFile: jest.fn(async () => undefined) };
    const { engine, baseStore } = await buildEngine(localAdapter, client);
    const base: FileState = { path: 'note.md', localHash: 'h', remoteId: 'r', idType: 'sha256', size: 1, mtime: 1, remoteFileId: 'f', isConflicted: false };
    // remote.checksum === base.localHash ⇒ server copy unchanged ⇒ genuine local deletion → propagate + drop base.
    await (engine as unknown as { applyLocalDeletion: (r: RemoteFileInfo, b: FileState, id: string, t: string, s: SyncSessionSummary) => Promise<void> })
      .applyLocalDeletion(remoteOf('note.md', 1, { checksum: 'h' }), base, 'r', 'sha256', makeSummary());
    expect(baseStore.delete).toHaveBeenCalledWith('note.md');
  });
});
