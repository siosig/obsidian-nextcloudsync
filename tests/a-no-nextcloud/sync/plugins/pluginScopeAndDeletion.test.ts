// Community plugin sync, engine level: community-plugins.json and unlisted plugin folders are never touched, and the
// deletion of a listed plugin's files goes through the ordinary mass-delete breaker. (docs/spec.md §7, §8)
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../../src/sync/SyncEngine';
import { StateDB } from '../../../../src/data/StateDB';
import { DEFAULT_SETTINGS, DavSyncSettings, RemoteFileInfo } from '../../../../src/types';
import { sha256 } from '../../../../src/util/hash';
import { TFile } from '../../support/obsidian';

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
const CONFIG_DIR = '.obsidian';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/nextcloud-sync`;
const LIST_PATH = `${CONFIG_DIR}/community-plugins.json`;
const PDIR = `${CONFIG_DIR}/plugins/p`;
const QDIR = `${CONFIG_DIR}/plugins/q`;
const MTIME = 1_000;
const PLUGIN_FILES = ['manifest.json', 'main.js', 'styles.css', 'data.json'].map(f => `${PDIR}/${f}`);
const MANIFEST_BODY = '{"id":"p","name":"P","version":"1.0.0"}';
const bodyOf = (path: string): string => (path === `${PDIR}/manifest.json` ? MANIFEST_BODY : `body of ${path}`);

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
  local: Record<string, string>;
  remote: Record<string, string>;
  // Local paths recorded as synced with their current content.
  tracked: string[];
  massDeleteLimit?: number;
}

async function buildWorld(input: WorldInput) {
  const vault = new Map<string, string>(Object.entries(input.local));
  const remote = new Map<string, string>(Object.entries(input.remote));
  const stateDB = new StateDB(stateAdapter(), PLUGIN_DIR, 'dev1');
  await stateDB.load();
  for (const path of input.tracked) {
    const body = input.local[path];
    const hash = await sha256(toBuf(body));
    const size = enc.encode(body).length;
    stateDB.setFile({
      path, localHash: hash, remoteId: hash, idType: 'sha256', size, mtime: MTIME,
      remoteFileId: `fid-${path}`, isConflicted: false, localMtime: MTIME, localSize: size, remoteMtime: MTIME,
    });
  }

  const writes: string[] = [];
  const removed: string[] = [];
  const sizeOf = (p: string): number => enc.encode(vault.get(p)!).length;
  const store = (p: string, data: string): void => { writes.push(p); vault.set(p, data); };
  const localAdapter = {
    listVaultFiles: jest.fn(() => [...vault.keys()].filter(p => !p.startsWith('.'))
      .map(p => ({ path: p, size: sizeOf(p), mtime: MTIME }))),
    list: jest.fn(async () => ({ files: [], folders: [] })),
    stat: jest.fn(async (p: string) => (vault.has(p) ? { size: sizeOf(p), mtime: MTIME } : null)),
    exists: jest.fn(async (p: string) => vault.has(p)),
    read: jest.fn(async (p: string) => vault.get(p) ?? ''),
    readBinary: jest.fn(async (p: string) => toBuf(vault.get(p) ?? '')),
    atomicWrite: jest.fn(async (p: string, d: string) => { store(p, d); }),
    atomicWriteBinary: jest.fn(async (p: string, d: ArrayBuffer) => { store(p, dec.decode(d)); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { store(p, dec.decode(d)); }),
    remove: jest.fn(async (p: string) => { removed.push(p); vault.delete(p); }),
    ignore: jest.fn(),
  };
  const remoteInfo = async (path: string, body: string): Promise<RemoteFileInfo> => ({
    path, fileId: `fid-${path}`, checksum: await sha256(toBuf(body)), etag: null,
    size: enc.encode(body).length, lastModified: MTIME,
  });
  const client = {
    getRootEtag: jest.fn(async (): Promise<string | null> => null),
    getFiles: jest.fn(async () => Promise.all([...remote.entries()].map(([p, b]) => remoteInfo(p, b)))),
    getDirectories: jest.fn(async () => []),
    getSyncToken: jest.fn(async (): Promise<string | null> => null),
    remoteExists: jest.fn(async (p: string) => remote.has(p)),
    statFile: jest.fn(async () => null),
    uploadFile: jest.fn(async (p: string, data: ArrayBuffer) => { remote.set(p, dec.decode(data)); }),
    deleteFile: jest.fn(async () => undefined),
    createDirectory: jest.fn(async () => undefined),
    isRemoteDirEmpty: jest.fn(async () => true),
    recalcChecksum: jest.fn(async () => null),
    downloadFile: jest.fn(async (p: string) => toBuf(remote.get(p) ?? '')),
  };
  const app = {
    vault: {
      adapter: {
        exists: jest.fn(async (p: string) => vault.has(p)),
        remove: jest.fn(async (p: string) => { removed.push(p); vault.delete(p); }),
        mkdir: jest.fn(async () => undefined),
      },
      getAbstractFileByPath: (p: string) => (vault.has(p) ? new TFile(p) : null),
      getAllFolders: () => [],
      configDir: CONFIG_DIR,
    },
    fileManager: { trashFile: jest.fn(async (f: TFile) => { removed.push(f.path); vault.delete(f.path); }) },
  };
  const settings: DavSyncSettings = {
    ...DEFAULT_SETTINGS, syncOnWifiOnly: false, syncConfigFolder: true, syncedCommunityPlugins: ['p'],
    ...(input.massDeleteLimit === undefined ? {} : { massDeleteLimit: input.massDeleteLimit }),
  };
  const engine = new SyncEngine({
    app, settings, localAdapter, stateDB,
    statusBar: { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn(), setPhase: jest.fn() },
    webdavFactory: { createClient: jest.fn(async () => ({ client, features: { isNextcloud: true } })) },
    pluginDir: PLUGIN_DIR, configDir: CONFIG_DIR,
  } as never);
  const sync = async (): Promise<void> => { await engine.syncManual({ manual: true }); await stateDB.flush(); };
  const uploaded = (): string[] => client.uploadFile.mock.calls.map(c => (c as unknown as [string])[0]);
  const deletedRemote = (): string[] => client.deleteFile.mock.calls.map(c => (c as unknown as [string])[0]);
  return { vault, remote, writes, removed, client, engine, stateDB, sync, uploaded, deletedRemote };
}

beforeEach(() => {
  (globalThis as { navigator?: unknown }).navigator ??= {};
});
afterEach(() => { jest.restoreAllMocks(); });

describe('[SPEC:CPS-2] community-plugins.json and unlisted plugins are never synced', () => {
  const LOCAL_LIST = '["p","local-only"]';
  const REMOTE_LIST = '["p","remote-only"]';
  const touchedPaths = [LIST_PATH, `${QDIR}/main.js`, `${QDIR}/manifest.json`];

  async function expectUntouched(w: Awaited<ReturnType<typeof buildWorld>>, localList: string | undefined): Promise<void> {
    for (const p of touchedPaths) {
      expect(w.uploaded()).not.toContain(p);
      expect(w.deletedRemote()).not.toContain(p);
      expect(w.writes).not.toContain(p);
      expect(w.removed).not.toContain(p);
    }
    expect(w.client.downloadFile).not.toHaveBeenCalledWith(LIST_PATH, expect.anything());
    expect(w.vault.get(LIST_PATH)).toBe(localList);
  }

  it('leaves a differing local and remote community-plugins.json alone (neither uploaded, downloaded nor deleted)', async () => {
    const w = await buildWorld({
      local: {
        [LIST_PATH]: LOCAL_LIST, [`${QDIR}/main.js`]: 'local q', [`${PDIR}/data.json`]: '{"a":1}',
        'unrelated.md': 'unrelated',
      },
      remote: {
        [LIST_PATH]: REMOTE_LIST, [`${QDIR}/manifest.json`]: '{"id":"q"}', 'unrelated.md': 'unrelated',
      },
      tracked: ['unrelated.md'],
    });
    await w.sync();
    // Positive control: the listed plugin's data.json is in scope, so the plugin sync really ran.
    expect(w.uploaded()).toContain(`${PDIR}/data.json`);
    await expectUntouched(w, LOCAL_LIST);
    expect(w.vault.has(`${QDIR}/manifest.json`)).toBe(false);
    expect(w.remote.get(LIST_PATH)).toBe(REMOTE_LIST);
  });

  it('does not delete the local file when a tracked community-plugins.json is absent on the server', async () => {
    const w = await buildWorld({
      local: { [LIST_PATH]: LOCAL_LIST, [`${PDIR}/data.json`]: '{"a":1}', 'unrelated.md': 'unrelated' },
      remote: { 'unrelated.md': 'unrelated' },
      tracked: [LIST_PATH, 'unrelated.md'],
    });
    await w.sync();
    expect(w.uploaded()).toContain(`${PDIR}/data.json`);
    await expectUntouched(w, LOCAL_LIST);
  });

  it('does not delete the server file or recreate the local one when a tracked community-plugins.json is absent locally', async () => {
    const w = await buildWorld({
      local: { [`${PDIR}/data.json`]: '{"a":1}', 'unrelated.md': 'unrelated' },
      remote: { [LIST_PATH]: REMOTE_LIST, 'unrelated.md': 'unrelated' },
      tracked: ['unrelated.md'],
    });
    w.stateDB.setFile({
      path: LIST_PATH, localHash: 'h', remoteId: 'h', idType: 'sha256', size: 1, mtime: MTIME,
      remoteFileId: `fid-${LIST_PATH}`, isConflicted: false, localMtime: MTIME, localSize: 1, remoteMtime: MTIME,
    });
    await w.sync();
    expect(w.uploaded()).toContain(`${PDIR}/data.json`);
    await expectUntouched(w, undefined);
    expect(w.remote.get(LIST_PATH)).toBe(REMOTE_LIST);
  });
});

describe('[SPEC:CPS-12] deleting a listed plugin\'s files is an ordinary deletion under the mass-delete breaker', () => {
  const notes = (n: number): string[] => Array.from({ length: n }, (_, i) => `note${i}.md`);
  const worldWithRemoteDeletions = (noteCount: number, massDeleteLimit?: number) => {
    // Everything is tracked and present locally; the server lost the four plugin files and `noteCount` notes.
    const kept = ['kept.md'];
    // The plugin is not enabled on this device, so its data.json is not held back for a restart (docs/spec.md §7).
    const local: Record<string, string> = { [LIST_PATH]: '[]' };
    for (const p of [...PLUGIN_FILES, ...notes(noteCount), ...kept]) local[p] = bodyOf(p);
    const remote: Record<string, string> = {};
    for (const p of kept) remote[p] = bodyOf(p);
    return buildWorld({ local, remote, tracked: Object.keys(local).filter(p => p !== LIST_PATH), massDeleteLimit });
  };

  it('counts the plugin files toward the limit and keeps every file when the total exceeds it', async () => {
    // 4 plugin files + 17 notes = 21 candidates > max(20, floor(0.2 * 22)) = 20. The 17 notes alone stay under the limit,
    // so the breaker fires only because the plugin files are counted.
    const w = await worldWithRemoteDeletions(17);
    await w.sync();

    const breaker = w.engine.getLastSessionSummary()?.errors.find(e => e.path === '(mass-delete breaker)');
    expect(breaker).toBeDefined();
    const skipped = breaker!.skippedPaths!.all;
    expect(skipped).toHaveLength(21);
    for (const p of PLUGIN_FILES) expect(skipped).toContain(p);
    for (const p of [...PLUGIN_FILES, ...notes(17)]) expect(w.vault.has(p)).toBe(true);
    expect(w.removed).toEqual([]);
  });

  it('propagates the deletion of the plugin files when the total stays within the limit', async () => {
    // 4 plugin files + 10 notes = 14 candidates <= 20.
    const w = await worldWithRemoteDeletions(10);
    await w.sync();

    expect(w.engine.getLastSessionSummary()?.errors.find(e => e.path === '(mass-delete breaker)')).toBeUndefined();
    for (const p of [...PLUGIN_FILES, ...notes(10)]) expect(w.vault.has(p)).toBe(false);
    expect(w.vault.has('kept.md')).toBe(true);
  });

  it('honours an explicit massDeleteLimit for plugin files like for any other file', async () => {
    // 4 plugin files + 2 notes = 6 candidates; a fixed limit of 5 stops them, which the automatic limit (20) would not.
    const w = await worldWithRemoteDeletions(2, 5);
    await w.sync();

    expect(w.engine.getLastSessionSummary()?.errors.some(e => e.path === '(mass-delete breaker)')).toBe(true);
    for (const p of PLUGIN_FILES) expect(w.vault.has(p)).toBe(true);
  });
});
