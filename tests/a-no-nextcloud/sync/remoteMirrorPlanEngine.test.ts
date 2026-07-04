// [SPEC:MIR-1] Regression: planRemoteMirror must lazily connect via ensureClient (like a normal sync),
// NOT read a possibly-null this.client. The shipped 0.7.22-beta.1 aborted with "Not signed in" when the
// mirror was invoked before any sync had populated this.client; this locks in the connect-on-demand fix.
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { sha256 } from '../../../src/util/hash';
import { DavSyncSettings, NextcloudFeatures, RemoteFileInfo } from '../../../src/types';

const remote = (path: string, checksum: string | null): RemoteFileInfo => ({
  path, fileId: null, checksum, etag: null, size: 1, lastModified: 0,
});

function settings(): DavSyncSettings {
  return {
    configDir: '.obsidian', syncConfigFolder: false, excludedFolders: [], maxFileSizeMB: 0,
    networkConcurrency: 4,
    configSync: { appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: false },
  } as unknown as DavSyncSettings;
}

function makeEngine(over: {
  getFiles?: jest.Mock;
  createThrows?: boolean;
  localFiles?: Array<{ path: string; content: Uint8Array }>;
  recalcChecksum?: jest.Mock;
}) {
  const feats: NextcloudFeatures = {
    isNextcloud: true, version: '30', hasChecksums: true, hasFilesLocking: false,
    hasBulkUpload: false, syncToken: null,
  };
  const localFiles = over.localFiles ?? [];
  const byPath = new Map(localFiles.map((f) => [f.path, f.content]));
  const client = {
    getFiles: over.getFiles ?? jest.fn(async () => [] as RemoteFileInfo[]),
    recalcChecksum: over.recalcChecksum ?? jest.fn(async () => null),
  };
  const localAdapter = {
    listVaultFiles: () => localFiles.map((f) => ({ path: f.path, size: f.content.byteLength, mtime: 0 })),
    list: jest.fn(async () => ({ files: [], folders: [] })),
    stat: jest.fn(async () => null),
    readBinary: jest.fn(async (p: string) => {
      const c = byPath.get(p);
      return (c ? c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength) : new ArrayBuffer(0)) as ArrayBuffer;
    }),
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

  it('[SPEC:MIR-1] skips an identical file whose server checksum was absent but is resolved on demand (no re-download)', async () => {
    // Migration case: the remote file was placed by another tool → PROPFIND returns checksum=null.
    // planRemoteMirror must recalc the checksum server-side (no download) so an identical local file
    // is SKIPPED, not re-downloaded (SC-004).
    const content = new TextEncoder().encode('same bytes on both sides');
    const hash = await sha256(content.buffer.slice(0) as ArrayBuffer);
    const getFiles = jest.fn(async () => [remote('same.md', null)]); // server has no stored checksum
    const recalcChecksum = jest.fn(async () => hash); // server computes it on demand (no download)
    const { engine } = makeEngine({
      getFiles, recalcChecksum,
      localFiles: [{ path: 'same.md', content }],
    });
    const plan = await engine.planRemoteMirror();
    expect(recalcChecksum).toHaveBeenCalledWith('same.md');
    expect(plan.downloads).toHaveLength(0); // NOT re-downloaded
    expect(plan.skipCount).toBe(1);
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
