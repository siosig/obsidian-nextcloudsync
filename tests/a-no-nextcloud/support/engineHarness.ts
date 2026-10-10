// Shared engine test harness: an in-memory local vault, a StateDB over a fake adapter, and helpers that
// drive the real SyncEngine.processRemoteFile.
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { DEFAULT_SETTINGS, FileState, RemoteFileInfo, SyncSessionSummary } from '../../../src/types';

export const enc = new TextEncoder();
export const dec = new TextDecoder();
export const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
export const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';

export function makeStateAdapter(): DataAdapter {
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

export function makeSummary(): SyncSessionSummary {
  return {
    startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
    mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
  };
}

// In-memory local vault. `files` maps path -> current content; a path that is absent means the file does
// not exist locally. mtimes are fixed per path so the deterministic strategies are predictable.
export function makeLocalAdapter(files: Record<string, string>, mtimes: Record<string, number> = {}) {
  const mtimeOf = (p: string): number => mtimes[p] ?? 1_000;
  return {
    files,
    stat: jest.fn(async (p: string) =>
      p in files ? { size: enc.encode(files[p]).length, mtime: mtimeOf(p) } : null),
    exists: jest.fn(async (p: string) => p in files),
    read: jest.fn(async (p: string) => files[p] ?? ''),
    readBinary: jest.fn(async (p: string) => toBuf(files[p] ?? '')),
    atomicWrite: jest.fn(async (p: string, d: string) => { files[p] = d; }),
    atomicWriteBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files[p] = dec.decode(d); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files[p] = dec.decode(d); }),
    setMtime: jest.fn(),
    remove: jest.fn(async (p: string) => { delete files[p]; }),
  };
}

export async function buildEngine(
  localAdapter: Record<string, unknown>,
  client: Record<string, unknown>,
  settings: Partial<typeof DEFAULT_SETTINGS> = {},
  uploadStrategy: Record<string, unknown> = { upload: jest.fn(async () => 'uploaded' as const) },
) {
  const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
  await stateDB.load();
  const baseStore = {
    get: jest.fn(() => undefined), set: jest.fn(), delete: jest.fn(),
    requestSave: jest.fn(), flush: jest.fn(async () => undefined),
  };
  const engine = new SyncEngine({
    app: {}, settings: { ...DEFAULT_SETTINGS, ...settings },
    localAdapter, stateDB, baseStore, statusBar: {}, webdavFactory: {},
    pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);
  (engine as unknown as { client: unknown }).client = client;
  (engine as unknown as { uploadStrategy: unknown }).uploadStrategy = uploadStrategy;
  return { engine, stateDB, baseStore };
}

export const callProcessRemote = (e: SyncEngine, r: RemoteFileInfo, s: SyncSessionSummary) =>
  (e as unknown as {
    processRemoteFile: (r: RemoteFileInfo, s: SyncSessionSummary) => Promise<void>;
  }).processRemoteFile(r, s);

export const remoteOf = (path: string, body: string, over: Partial<RemoteFileInfo> = {}): RemoteFileInfo =>
  ({
    path, fileId: 'f1', checksum: null, etag: 'remote-etag',
    size: enc.encode(body).length, lastModified: 9_000, ...over,
  });

// Seed an unrelated tracked file so the StateDB is non-empty (the engine is past its first sync).
export function seedUnrelated(stateDB: StateDB): void {
  const other: FileState = {
    path: 'unrelated.md', localHash: 'h', remoteId: 'h', idType: 'sha256',
    size: 1, mtime: 1, remoteFileId: null, isConflicted: false,
  };
  stateDB.setFile(other);
}
