// [SPEC:MIR-1] Regression: planRemoteMirror must lazily connect via ensureClient (like a normal sync),
// NOT read a possibly-null this.client. The shipped 0.7.22-beta.1 aborted with "Not signed in" when the
// mirror was invoked before any sync had populated this.client; this locks in the connect-on-demand fix.
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { DavSyncSettings, NextcloudFeatures, RemoteFileInfo } from '../../../src/types';

const remote = (path: string, checksum: string): RemoteFileInfo => ({
  path, fileId: null, checksum, etag: null, size: 1, lastModified: 0,
});

function settings(): DavSyncSettings {
  return {
    configDir: '.obsidian', syncConfigFolder: false, excludedFolders: [], maxFileSizeMB: 0,
    configSync: { appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: false },
  } as unknown as DavSyncSettings;
}

function makeEngine(over: { getFiles?: jest.Mock; createThrows?: boolean }) {
  const feats: NextcloudFeatures = {
    isNextcloud: true, version: '30', hasChecksums: true, hasFilesLocking: false,
    hasBulkUpload: false, syncToken: null,
  };
  const client = { getFiles: over.getFiles ?? jest.fn(async () => [] as RemoteFileInfo[]) };
  const localAdapter = {
    listVaultFiles: () => [],
    list: jest.fn(async () => ({ files: [], folders: [] })),
    stat: jest.fn(async () => null),
    readBinary: jest.fn(async () => new ArrayBuffer(0)),
  };
  const vault = { adapter: localAdapter, getAllFolders: () => [] };
  const stateDB = { getFile: () => undefined, getAllFiles: () => [], getAllDirs: () => [] };
  const createClient = over.createThrows
    ? jest.fn(async () => { throw new Error('no credentials'); })
    : jest.fn(async () => ({ client, features: feats }));
  const engine = new SyncEngine({
    app: { vault, fileManager: {} }, settings: settings(), localAdapter,
    stateDB, statusBar: {}, webdavFactory: { createClient }, onFeatures: jest.fn(),
    pluginDir: '.obsidian/plugins/nextcloud-sync', configDir: '.obsidian',
  } as never);
  return { engine, client, createClient };
}

describe('[SPEC:MIR-1] SyncEngine.planRemoteMirror — connects on demand', () => {
  it('connects via ensureClient (does not require a prior sync) and classifies the remote', async () => {
    const getFiles = jest.fn(async () => [remote('a.md', 'ha'), remote('b.md', 'hb')]);
    const { engine, createClient } = makeEngine({ getFiles });
    const plan = await engine.planRemoteMirror();
    expect(createClient).toHaveBeenCalledTimes(1); // built the client itself — no "Not signed in"
    expect(plan.ok).toBe(true);
    expect(plan.downloads.map((d) => d.path).sort()).toEqual(['a.md', 'b.md']);
  });

  it('returns ok:false (not a crash) when the server cannot be connected', async () => {
    const { engine } = makeEngine({ createThrows: true });
    const plan = await engine.planRemoteMirror();
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('Not connected');
    expect(plan.deleteFiles).toHaveLength(0);
  });

  it('returns ok:false when the remote listing throws (abort gate, zero deletions)', async () => {
    const getFiles = jest.fn(async () => { throw new Error('PROPFIND 500'); });
    const { engine } = makeEngine({ getFiles });
    const plan = await engine.planRemoteMirror();
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('Failed to list the remote');
    expect(plan.deleteFiles).toHaveLength(0);
  });
});
