// A Map-backed vault and a fake server wired into a real SyncEngine, for the size-limit skip notice tests
// (docs/spec.md §9.4a). Every file body is a string; local and remote entries share one mtime so only the
// size limit decides what is skipped.
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { DEFAULT_SETTINGS, DavSyncSettings, RemoteFileInfo } from '../../../src/types';
import { sha256 } from '../../../src/util/hash';
import { Notice, TFile } from './obsidian';

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;

/** 0.001 MB = 1048.576 bytes: a body longer than this is over the limit. */
export const LIMIT_MB = 0.001;
/** Over the limit (2048 B). */
export const OVER = 'o'.repeat(2048);
/** Over `LIMIT_MB` but within 0.0015 MB (1572.864 B). */
export const OVER_SMALL = 's'.repeat(1500);
/** Within the limit (512 B). */
export const UNDER = 'u'.repeat(512);
export const CONFIG_DIR = '.obsidian';

const PLUGIN_DIR = `${CONFIG_DIR}/plugins/nextcloud-sync`;
const MTIME = 1_000;
const UPLOADED_MTIME = 9_000;

export interface Entry { body: string; mtime: number }

export interface OversizeWorldInput {
  local?: Array<[string, string]>;
  remote?: Array<[string, string]>;
  /** Seed one tracked unrelated note so the engine runs the incremental path. */
  incremental?: boolean;
  settings?: Partial<DavSyncSettings>;
}

export function notices(): Array<{ message: string; timeout?: number }> {
  return Notice.instances;
}

/** The size-limit count notices (one per manual sync with at least one skip). */
export function skipNotices(): Array<{ message: string; timeout?: number }> {
  return notices().filter(n => n.message.startsWith('⚠️ Skipped '));
}

/** The per-file notices this feature removed. */
export function perFileSizeNotices(): Array<{ message: string; timeout?: number }> {
  return notices().filter(n => n.message.includes('File too large to sync') || n.message.includes('File too large to download'));
}

export function skipLogLines(logs: string[]): string[] {
  return logs.filter(l => l.startsWith('size-limit: skipped '));
}

export function sessionLogLines(logs: string[]): string[] {
  return logs.filter(l => l.startsWith('size-limit: session total='));
}

function stateAdapter(): DataAdapter {
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

async function remoteInfo(path: string, e: Entry): Promise<RemoteFileInfo> {
  return {
    path, fileId: `fid-${path}`, checksum: await sha256(toBuf(e.body)), etag: null,
    size: enc.encode(e.body).length, lastModified: e.mtime,
  };
}

export async function buildOversizeWorld(input: OversizeWorldInput) {
  const vault = new Map<string, Entry>((input.local ?? []).map(([p, body]) => [p, { body, mtime: MTIME }]));
  const remote = new Map<string, Entry>((input.remote ?? []).map(([p, body]) => [p, { body, mtime: MTIME }]));
  const hiddenFromScan = new Set<string>();
  if (input.incremental) {
    vault.set('unrelated.md', { body: 'unrelated', mtime: MTIME });
    remote.set('unrelated.md', { body: 'unrelated', mtime: MTIME });
  }
  const stateDB = new StateDB(stateAdapter(), PLUGIN_DIR, 'dev1');
  await stateDB.load();
  if (input.incremental) {
    const body = 'unrelated';
    const hash = await sha256(toBuf(body));
    const size = enc.encode(body).length;
    stateDB.setFile({
      path: 'unrelated.md', localHash: hash, remoteId: hash, idType: 'sha256', size, mtime: MTIME,
      remoteFileId: 'fid-unrelated.md', isConflicted: false, localMtime: MTIME, localSize: size, remoteMtime: MTIME,
    });
  }

  const sizeOf = (p: string): number => enc.encode(vault.get(p)!.body).length;
  const store = (p: string, data: string, mtime?: number): void => {
    vault.set(p, { body: data, mtime: mtime ?? Date.now() });
  };
  const localAdapter = {
    listVaultFiles: jest.fn(() => [...vault.keys()].filter(p => !p.startsWith('.') && !hiddenFromScan.has(p))
      .map(p => ({ path: p, size: sizeOf(p), mtime: vault.get(p)!.mtime }))),
    list: jest.fn(async () => ({ files: [], folders: [] })),
    stat: jest.fn(async (p: string) => (vault.has(p) ? { size: sizeOf(p), mtime: vault.get(p)!.mtime } : null)),
    exists: jest.fn(async (p: string) => vault.has(p)),
    read: jest.fn(async (p: string) => vault.get(p)?.body ?? ''),
    readBinary: jest.fn(async (p: string) => toBuf(vault.get(p)?.body ?? '')),
    atomicWrite: jest.fn(async (p: string, d: string, m?: number) => { store(p, d, m); }),
    atomicWriteBinary: jest.fn(async (p: string, d: ArrayBuffer, m?: number) => { store(p, dec.decode(d), m); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { store(p, dec.decode(d)); }),
    remove: jest.fn(async (p: string) => { vault.delete(p); }),
    ignore: jest.fn(),
  };

  const listing = async (): Promise<RemoteFileInfo[]> =>
    Promise.all([...remote.entries()].map(([p, e]) => remoteInfo(p, e)));
  const client = {
    getRootEtag: jest.fn(async (): Promise<string | null> => null),
    getFiles: jest.fn((): Promise<RemoteFileInfo[]> => listing()),
    getDirectories: jest.fn(async () => []),
    getSyncToken: jest.fn(async (): Promise<string | null> => null),
    remoteExists: jest.fn(async (p: string) => remote.has(p)),
    statFile: jest.fn(async () => null),
    uploadFile: jest.fn(async (p: string, data: ArrayBuffer) => {
      remote.set(p, { body: dec.decode(data), mtime: UPLOADED_MTIME });
    }),
    deleteFile: jest.fn(async () => undefined),
    createDirectory: jest.fn(async () => undefined),
    isRemoteDirEmpty: jest.fn(async () => true),
    recalcChecksum: jest.fn(async () => null),
    downloadFile: jest.fn(async (p: string) => toBuf(remote.get(p)?.body ?? '')),
  };
  const app = {
    vault: {
      adapter: {
        exists: jest.fn(async (p: string) => vault.has(p)),
        remove: jest.fn(async (p: string) => { vault.delete(p); }),
        mkdir: jest.fn(async () => undefined),
      },
      getAbstractFileByPath: (p: string) => (vault.has(p) ? new TFile(p) : null),
      getAllFolders: () => [],
      configDir: CONFIG_DIR,
    },
    fileManager: { trashFile: jest.fn(async (f: TFile) => { vault.delete(f.path); }) },
  };

  const logs: string[] = [];
  const logEntries: Array<{ message: string; level?: string }> = [];
  const logger = {
    log: jest.fn(async (message: string, level?: string) => { logs.push(message); logEntries.push({ message, level }); }),
  };
  const skipNoticesAtComplete: number[] = [];
  const statusBar = {
    setStatus: jest.fn(),
    setProgress: jest.fn(),
    // Records how many count notices were already visible when the result was shown.
    setSyncComplete: jest.fn((..._args: unknown[]): void => { skipNoticesAtComplete.push(skipNotices().length); }),
    skipNoticesAtComplete,
  };
  const settings: DavSyncSettings = {
    ...DEFAULT_SETTINGS, syncOnWifiOnly: false, maxFileSizeMB: LIMIT_MB, ...input.settings,
  };
  const engine = new SyncEngine({
    app, settings, localAdapter, stateDB, statusBar, logger,
    webdavFactory: { createClient: jest.fn(async () => ({ client, features: { isNextcloud: true } })) },
    pluginDir: PLUGIN_DIR, configDir: CONFIG_DIR,
  } as never);

  return {
    engine, stateDB, settings, vault, remote, hiddenFromScan, client, logs, logEntries, statusBar, listing,
    // "Sync now": the manual trigger.
    manual: async (): Promise<void> => { await engine.syncManual({ manual: true }); await stateDB.flush(); },
    // Startup sync: no argument, the automatic trigger (src/main.ts).
    automatic: async (): Promise<void> => { await engine.syncManual(); await stateDB.flush(); },
  };
}

export type OversizeWorld = Awaited<ReturnType<typeof buildOversizeWorld>>;
