// Plugin bundle convergence: a half-written bundle heals on the next sync, manifest.json is written last in every
// apply path, and a plugin data.json is written with the write time as its mtime. (docs/spec.md §7, §9.6)
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../../src/sync/SyncEngine';
import { StateDB } from '../../../../src/data/StateDB';
import { DEFAULT_SETTINGS, DavSyncSettings, NetworkError, RemoteFileInfo } from '../../../../src/types';
import { sha256 } from '../../../../src/util/hash';
import { TFile } from '../../support/obsidian';

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
const CONFIG_DIR = '.obsidian';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/nextcloud-sync`;
const PDIR = `${CONFIG_DIR}/plugins/p`;
const OLD_MTIME = 1_000;
const NEW_MTIME = 9_000;
const CODE = ['manifest.json', 'main.js', 'styles.css'];
const codePaths = CODE.map(f => `${PDIR}/${f}`);

const manifestBody = (version: string): string => `{"id":"p","name":"P","version":"${version}"}`;
const bodyOf = (file: string, version: string): string =>
  (file === 'manifest.json' ? manifestBody(version) : `${version} body of ${file}`);

interface Entry { body: string; mtime: number }
const entryOf = (file: string, version: string, mtime: number): [string, Entry] =>
  [`${PDIR}/${file}`, { body: bodyOf(file, version), mtime }];

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

interface WorldInput {
  // Entries in insertion order; the order is the order of the local scan / the remote listing.
  local: Array<[string, Entry]>;
  remote: Array<[string, Entry]>;
  // Track the local entries as synced with the same content (so the engine runs the incremental path).
  trackLocal?: boolean;
  // Seed one unrelated tracked note so the StateDB is non-empty and the engine runs incrementalSync.
  incremental: boolean;
}

async function remoteInfo(path: string, e: Entry): Promise<RemoteFileInfo> {
  return {
    path, fileId: `fid-${path}`, checksum: await sha256(toBuf(e.body)), etag: null,
    size: enc.encode(e.body).length, lastModified: e.mtime,
  };
}

async function buildWorld(input: WorldInput) {
  const vault = new Map<string, Entry>(input.local);
  const remote = new Map<string, Entry>(input.remote);
  if (input.incremental) {
    vault.set('unrelated.md', { body: 'unrelated', mtime: OLD_MTIME });
    remote.set('unrelated.md', { body: 'unrelated', mtime: OLD_MTIME });
  }
  const stateDB = new StateDB(stateAdapter(), PLUGIN_DIR, 'dev1');
  await stateDB.load();
  if (input.incremental) {
    const tracked = input.trackLocal ? [...vault.entries()] : [['unrelated.md', vault.get('unrelated.md')!] as const];
    for (const [path, e] of tracked) {
      const hash = await sha256(toBuf(e.body));
      const size = enc.encode(e.body).length;
      stateDB.setFile({
        path, localHash: hash, remoteId: hash, idType: 'sha256', size, mtime: e.mtime,
        remoteFileId: `fid-${path}`, isConflicted: false, localMtime: e.mtime, localSize: size, remoteMtime: e.mtime,
      });
    }
  }

  const writes: string[] = [];
  const writeMtimes = new Map<string, number | undefined>();
  const failOnce = new Set<string>();
  const sizeOf = (p: string): number => enc.encode(vault.get(p)!.body).length;
  const store = (p: string, data: string, mtime?: number): void => {
    writes.push(p);
    writeMtimes.set(p, mtime);
    vault.set(p, { body: data, mtime: mtime ?? Date.now() });
  };
  const localAdapter = {
    listVaultFiles: jest.fn(() => [...vault.keys()].filter(p => !p.startsWith('.'))
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
  const client = {
    getRootEtag: jest.fn(async (): Promise<string | null> => null),
    getFiles: jest.fn(async () => Promise.all([...remote.entries()].map(([p, e]) => remoteInfo(p, e)))),
    getDirectories: jest.fn(async () => []),
    getSyncToken: jest.fn(async (): Promise<string | null> => null),
    remoteExists: jest.fn(async (p: string) => remote.has(p)),
    statFile: jest.fn(async () => null),
    uploadFile: jest.fn(async () => undefined),
    deleteFile: jest.fn(async () => undefined),
    createDirectory: jest.fn(async () => undefined),
    isRemoteDirEmpty: jest.fn(async () => true),
    recalcChecksum: jest.fn(async () => null),
    downloadFile: jest.fn(async (p: string) => {
      if (failOnce.delete(p)) throw new NetworkError(503, 'unavailable', 'GET');
      return toBuf(remote.get(p)?.body ?? '');
    }),
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
  const settings: DavSyncSettings = {
    ...DEFAULT_SETTINGS, syncOnWifiOnly: false, syncConfigFolder: true, syncedCommunityPlugins: ['p'],
  };
  const engine = new SyncEngine({
    app, settings, localAdapter, stateDB,
    statusBar: { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn(), setPhase: jest.fn() },
    webdavFactory: { createClient: jest.fn(async () => ({ client, features: { isNextcloud: true } })) },
    pluginDir: PLUGIN_DIR, configDir: CONFIG_DIR,
  } as never);
  const sync = async (): Promise<void> => { await engine.syncManual({ manual: true }); await stateDB.flush(); };
  const retryQueue = (): string[] => (engine as unknown as { retryQueue: string[] }).retryQueue;
  return { vault, remote, writes, writeMtimes, failOnce, client, engine, stateDB, sync, retryQueue };
}

// The order in which the code files of `p` were written (data.json is not code).
const codeWriteOrder = (writes: string[]): string[] => writes.filter(p => codePaths.includes(p));

beforeEach(() => {
  (globalThis as { navigator?: unknown }).navigator ??= {};
});
afterEach(() => { jest.restoreAllMocks(); });

describe('[SPEC:CPS-14] a half-written bundle converges', () => {
  it('heals a bundle whose main.js download failed once, and reports the restart in both syncs', async () => {
    const w = await buildWorld({
      incremental: true, trackLocal: true,
      local: CODE.map(f => entryOf(f, '1.0.0', OLD_MTIME)),
      remote: CODE.map(f => entryOf(f, '2.0.0', NEW_MTIME)),
    });
    w.stateDB.setRemoteRootEtag('root-etag-1');
    w.failOnce.add(`${PDIR}/main.js`);

    await w.sync();
    expect(w.vault.get(`${PDIR}/manifest.json`)!.body).toBe(bodyOf('manifest.json', '2.0.0'));
    expect(w.vault.get(`${PDIR}/styles.css`)!.body).toBe(bodyOf('styles.css', '2.0.0'));
    expect(w.vault.get(`${PDIR}/main.js`)!.body).toBe(bodyOf('main.js', '1.0.0'));
    expect(w.retryQueue()).toContain(`${PDIR}/main.js`);
    expect(w.stateDB.getRemoteRootEtag()).toBeNull();
    expect(w.engine.getLastSessionSummary()?.pluginsNeedingRestart).toContain('p');

    await w.sync();
    for (const f of CODE) expect(w.vault.get(`${PDIR}/${f}`)!.body).toBe(bodyOf(f, '2.0.0'));
    expect(w.engine.getLastSessionSummary()?.pluginsNeedingRestart).toContain('p');
  });

  it('writes manifest.json last in incrementalSync', async () => {
    const w = await buildWorld({
      incremental: true, local: [],
      remote: CODE.map(f => entryOf(f, '2.0.0', NEW_MTIME)),
    });
    await w.sync();
    expect(codeWriteOrder(w.writes)).toHaveLength(3);
    expect(codeWriteOrder(w.writes).at(-1)).toBe(`${PDIR}/manifest.json`);
  });

  it('writes manifest.json last in executePlan when every code file is a download', async () => {
    const w = await buildWorld({
      incremental: false, local: [],
      remote: CODE.map(f => entryOf(f, '2.0.0', NEW_MTIME)),
    });
    await w.sync();
    expect(codeWriteOrder(w.writes)).toHaveLength(3);
    expect(codeWriteOrder(w.writes).at(-1)).toBe(`${PDIR}/manifest.json`);
  });

  it('writes manifest.json last in executePlan when the code splits into downloads and conflicts', async () => {
    // manifest.json and styles.css exist locally with other content (conflicts); main.js is absent (download).
    const w = await buildWorld({
      incremental: false,
      local: [entryOf('manifest.json', '1.0.0', OLD_MTIME), entryOf('styles.css', '1.0.0', OLD_MTIME)],
      remote: CODE.map(f => entryOf(f, '2.0.0', NEW_MTIME)),
    });
    await w.sync();
    for (const f of CODE) expect(w.vault.get(`${PDIR}/${f}`)!.body).toBe(bodyOf(f, '2.0.0'));
    expect(codeWriteOrder(w.writes)).toHaveLength(3);
    expect(codeWriteOrder(w.writes).at(-1)).toBe(`${PDIR}/manifest.json`);
  });

  it('writes manifest.json last in executePlan when manifest.json is a download and styles.css a conflict', async () => {
    // Downloaded manifest.json must still come after the conflict-resolved styles.css.
    const w = await buildWorld({
      incremental: false,
      local: [entryOf('styles.css', '1.0.0', OLD_MTIME)],
      remote: CODE.map(f => entryOf(f, '2.0.0', NEW_MTIME)),
    });
    await w.sync();
    expect(codeWriteOrder(w.writes)).toHaveLength(3);
    expect(codeWriteOrder(w.writes).at(-1)).toBe(`${PDIR}/manifest.json`);
  });
});

describe('[SPEC:CPS-14] mirror from remote writes manifest.json last', () => {
  it('writes manifest.json after the other code files of the plugin', async () => {
    const w = await buildWorld({
      incremental: false, local: [],
      remote: CODE.map(f => entryOf(f, '2.0.0', NEW_MTIME)),
    });
    await w.engine.applyRemoteMirror(await w.engine.planRemoteMirror());
    expect(codeWriteOrder(w.writes)).toHaveLength(3);
    expect(codeWriteOrder(w.writes).at(-1)).toBe(`${PDIR}/manifest.json`);
  });
});

describe('[SPEC:CPS-19] plugin data.json is written with the write time as mtime', () => {
  it('stamps data.json with the write time, keeps remote mtimes elsewhere, and does not upload it next', async () => {
    const WRITE_TIME = 123_456_789_000;
    jest.spyOn(Date, 'now').mockReturnValue(WRITE_TIME);
    // The plugin is not enabled locally, so its data.json is not held back in the sync that delivers the code.
    const w = await buildWorld({
      incremental: true, local: [[`${CONFIG_DIR}/community-plugins.json`, { body: '["q"]', mtime: OLD_MTIME }]],
      remote: [
        ['note.md', { body: 'a note', mtime: 5_000 }],
        ...CODE.map(f => entryOf(f, '2.0.0', 6_000)),
        entryOf('data.json', '2.0.0', 7_000),
      ],
    });

    await w.sync();
    expect(w.writeMtimes.get(`${PDIR}/data.json`)).toBe(WRITE_TIME);
    expect(w.writeMtimes.get('note.md')).toBe(5_000);
    expect(w.writeMtimes.get(`${PDIR}/manifest.json`)).toBe(6_000);

    w.client.uploadFile.mockClear();
    await w.sync();
    expect(w.client.uploadFile.mock.calls.map(c => (c as unknown[])[0])).not.toContain(`${PDIR}/data.json`);
    expect(w.engine.getLastSessionSummary()?.uploadedCount).toBe(0);
  });
});
