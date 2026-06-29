import { SyncEngine } from '../../../src/sync/SyncEngine';
import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { DavSyncSettings, DEFAULT_SETTINGS, ConfigSyncCategories, SyncSessionSummary, RemoteFileInfo, FileState } from '../../../src/types';
import { DataAdapter, Vault } from 'obsidian';

function makeDataAdapter(overrides: Partial<DataAdapter> = {}): DataAdapter {
  return {
    read: jest.fn(),
    write: jest.fn(),
    readBinary: jest.fn(async () => new ArrayBuffer(0)),
    writeBinary: jest.fn(),
    exists: jest.fn(async () => false),
    remove: jest.fn(),
    rename: jest.fn(),
    mkdir: jest.fn(),
    stat: jest.fn(async () => null),
    list: jest.fn(async () => ({ files: [], folders: [] })),
    ...overrides,
  } as unknown as DataAdapter;
}

function makeEmptyVault(adapter: DataAdapter): Vault {
  return {
    adapter,
    getAbstractFileByPath: jest.fn(() => null),
    getFiles: jest.fn(() => []),
    trash: jest.fn(),
  } as unknown as Vault;
}

/**
 * Config-folder sync wiring in SyncEngine:
 *  - local scan injects enabled-category files (US1)
 *  - hard exclusions (plugins/, the plugin dir) survive every toggle, including via the
 *    remote-deletion scope guard (US2 / FR-003 / FR-004 / FR-008)
 */

const enc = new TextEncoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer;
const CONFIG_DIR = '.obsidian';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/nextcloud-sync`;

function settings(syncConfigFolder: boolean, configSync: Partial<ConfigSyncCategories>): DavSyncSettings {
  return {
    configDir: CONFIG_DIR,
    syncConfigFolder,
    configSync: { bookmarks: false, others: false, ...configSync },
  } as unknown as DavSyncSettings;
}

function makeSummary(): SyncSessionSummary {
  return {
    startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0,
    deletedCount: 0, mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
  };
}

describe('SyncEngine local-scan injection (config folder)', () => {
  it('injects an enabled-category file that exists, and excludes disabled categories', async () => {
    // Vault is empty (config-folder files are not Vault-tracked); stat provides the file's presence.
    const present = new Set<string>([`${CONFIG_DIR}/appearance.json`]);
    const rawAdapter = makeDataAdapter({
      stat: jest.fn(async (p: string) => (present.has(p) ? { size: 3, mtime: 1 } as never : null)),
      readBinary: jest.fn(async () => toBuf('{}')),
    });
    const vault = makeEmptyVault(rawAdapter);
    const localAdapter = new LocalAdapter(rawAdapter, vault);
    const engine = new SyncEngine({
      app: {}, settings: settings(true, { others: true }), localAdapter,
      stateDB: {}, statusBar: {}, webdavFactory: {}, pluginDir: PLUGIN_DIR, configDir: CONFIG_DIR,
    } as never);

    const scan = await (engine as unknown as {
      scanLocalFiles(): Promise<Map<string, unknown>>;
    }).scanLocalFiles();

    expect(scan.has(`${CONFIG_DIR}/appearance.json`)).toBe(true); // Other settings ON + on disk → injected
    expect(scan.has(`${CONFIG_DIR}/app.json`)).toBe(false);       // app.json absent on disk
    expect(scan.has(`${CONFIG_DIR}/hotkeys.json`)).toBe(false);   // hotkeys.json absent on disk
  });

  it('injects nothing under the config folder when the master is OFF', async () => {
    const rawAdapter = makeDataAdapter({
      stat: jest.fn(async () => ({ size: 3, mtime: 1 } as never)),
      readBinary: jest.fn(async () => toBuf('{}')),
    });
    const vault = makeEmptyVault(rawAdapter);
    const localAdapter = new LocalAdapter(rawAdapter, vault);
    const engine = new SyncEngine({
      app: {}, settings: settings(false, { others: true }), localAdapter,
      stateDB: {}, statusBar: {}, webdavFactory: {}, pluginDir: PLUGIN_DIR, configDir: CONFIG_DIR,
    } as never);

    const scan = await (engine as unknown as {
      scanLocalFiles(): Promise<Map<string, unknown>>;
    }).scanLocalFiles();

    expect([...scan.keys()].some(p => p.startsWith(`${CONFIG_DIR}/`))).toBe(false);
  });
});

describe('SyncEngine remote-deletion scope guard (config folder hard exclusions)', () => {
  function buildDeletionHarness(s: DavSyncSettings) {
    const remove = jest.fn(async () => undefined);
    const trashFile = jest.fn(async () => undefined);
    const exists = jest.fn(async () => true);
    const getAbstractFileByPath = jest.fn(() => null);
    const deleteFile = jest.fn();
    const app = {
      vault: { adapter: { exists, remove }, getAbstractFileByPath },
      fileManager: { trashFile },
    };
    const engine = new SyncEngine({
      app, settings: s, stateDB: { deleteFile }, configDir: CONFIG_DIR,
      localAdapter: {}, statusBar: {}, webdavFactory: {}, pluginDir: PLUGIN_DIR,
    } as never);
    const invoke = (path: string) =>
      (engine as unknown as {
        processRemoteDeletion(p: string, s: SyncSessionSummary): Promise<void>;
      }).processRemoteDeletion(path, makeSummary());
    return { invoke, remove };
  }

  const allOn = settings(true, { others: true, bookmarks: true });

  it('ignores deletion of a community plugin file even with ALL categories on', async () => {
    const h = buildDeletionHarness(allOn);
    await h.invoke(`${CONFIG_DIR}/plugins/some-plugin/main.js`);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it("ignores deletion of this plugin's own state DB even with ALL categories on", async () => {
    const h = buildDeletionHarness(allOn);
    await h.invoke(`${PLUGIN_DIR}/state.json`);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('still processes deletion of an enabled config file (appearance.json)', async () => {
    const h = buildDeletionHarness(allOn);
    await h.invoke(`${CONFIG_DIR}/appearance.json`);
    expect(h.remove).toHaveBeenCalledTimes(1); // in scope → legitimate deletion proceeds
  });
});

// Feature 037 FR-013: the old config-folder newest-wins special branch in handleConflict was removed.
// A `.obsidian` JSON conflict now flows through the single dispatch as an Other File: its extension
// (json) is not in autoMergeFileTypes, so it takes otherFileStrategy (default latest-mtime), which is
// JSON-safe (never writes conflict markers). Equal mtime → no-op, re-evaluated next sync (self-healing).
describe('[SPEC:CSF-12] config JSON conflict resolves via Other File / latest-mtime (no special branch)', () => {
  const enc2 = new TextEncoder();
  const toBuf2 = (s: string): ArrayBuffer => enc2.encode(s).buffer;

  function harness(localMtime: number, remoteMtime: number) {
    const setFile = jest.fn();
    const atomicWriteBinary = jest.fn(async () => undefined);
    const localAdapter = {
      stat: jest.fn(async () => ({ size: 7, mtime: localMtime })),
      read: jest.fn(async () => '{"a":1}'),
      readBinary: jest.fn(async () => toBuf2('{"a":1}')),
      atomicWrite: jest.fn(async () => undefined),
      atomicWriteBinary,
      setMtime: jest.fn(async () => undefined),
    };
    const stateDB = { setFile, getFile: jest.fn(() => undefined) };
    const client = { downloadFile: jest.fn(async () => toBuf2('{"a":2}')) };
    const upload = jest.fn(async () => 'uploaded' as const);
    const engine = new SyncEngine({
      app: {}, settings: { ...DEFAULT_SETTINGS, deviceId: 'dev-abcd' }, localAdapter, stateDB,
      statusBar: {}, webdavFactory: {}, pluginDir: PLUGIN_DIR, configDir: CONFIG_DIR,
    } as never);
    (engine as unknown as { client: unknown }).client = client;
    (engine as unknown as { uploadStrategy: unknown }).uploadStrategy = { upload };
    const remote: RemoteFileInfo = {
      path: `${CONFIG_DIR}/appearance.json`, fileId: 'f', checksum: 'c', etag: 'e',
      size: toBuf2('{"a":2}').byteLength, lastModified: remoteMtime,
    };
    const invoke = (base: FileState | undefined, summary: SyncSessionSummary) =>
      (engine as unknown as {
        handleConflict(p: string, b: FileState | undefined, r: RemoteFileInfo, id: string, t: FileState['idType'], s: SyncSessionSummary): Promise<void>;
      }).handleConflict(`${CONFIG_DIR}/appearance.json`, base, remote, 'c', 'sha256', summary);
    return { invoke, atomicWriteBinary, upload, setFile };
  }

  it('[SPEC:CSF-12] remote newer → local overwritten by remote (no markers, JSON-safe)', async () => {
    const h = harness(1000, 2000);
    const summary = makeSummary();
    await h.invoke(undefined, summary);
    expect(h.atomicWriteBinary).toHaveBeenCalledTimes(1);
    expect(summary.downloadedCount).toBe(1);
  });

  it('[SPEC:CSF-12] equal mtime → no-op success (converges next sync, no error, not conflicted)', async () => {
    const base: FileState = {
      path: `${CONFIG_DIR}/appearance.json`, localHash: 'lh', remoteId: 'rh', idType: 'sha256',
      size: 7, mtime: 1500, remoteFileId: 'f', isConflicted: false,
    };
    const h = harness(1500, 1500);
    const summary = makeSummary();
    await h.invoke(base, summary);
    expect(h.atomicWriteBinary).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    expect(summary.errorCount).toBe(0);
    expect(summary.conflictedCount).toBe(0);
    expect(h.setFile).not.toHaveBeenCalled();
  });
});
