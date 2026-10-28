// [SPEC:MT-6] A path that writes no content leaves the local mtime unchanged (docs/spec.md §9.6). The first-sync seed loop
// (plan.unchanged: both sides identical) only records State; it never touches the local file or its mtime.
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { RemoteFileInfo } from '../../../src/types';

const SETTINGS = {
  syncConfigFolder: false,
  configSync: { appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: false },
  networkConcurrency: 8,
};

const REMOTE_MTIME = Date.UTC(2020, 0, 1);
const LOCAL_MTIME = Date.UTC(2024, 5, 15);

function makeEngine(localAdapter: unknown, stateDB: unknown) {
  const opts = {
    app: {}, settings: SETTINGS, localAdapter,
    stateDB, statusBar: { setProgress: jest.fn(), setPhase: jest.fn() }, webdavFactory: {},
    pluginDir: '.obsidian/plugins/x', configDir: '.obsidian',
  };
  return new SyncEngine(opts as never);
}

function remoteOf(over: Partial<RemoteFileInfo> = {}): RemoteFileInfo {
  return {
    path: 'a.md', size: 4, checksum: 'abc123', fileId: 'f1', lastModified: REMOTE_MTIME, ...over,
  } as RemoteFileInfo;
}

async function runSeed(remote: RemoteFileInfo) {
  const localAdapter = {
    atomicWrite: jest.fn(async () => undefined),
    atomicWriteBinary: jest.fn(async () => undefined),
    stat: jest.fn(async () => ({ size: 4, mtime: LOCAL_MTIME })),
  };
  const setFile = jest.fn();
  const engine = makeEngine(localAdapter, { setFile });
  (engine as unknown as { client: unknown }).client = {};
  (engine as unknown as { uploadStrategy: unknown }).uploadStrategy = { upload: jest.fn(async () => 'skipped') };
  const localFiles = new Map([[remote.path, { size: 4, mtime: LOCAL_MTIME }]]);
  await (engine as unknown as {
    executePlan(p: unknown, r: unknown[], s: unknown, l: unknown): Promise<void>;
  }).executePlan(
    { uploads: [], downloads: [], conflicts: [], unchanged: [remote.path], deletes: [] },
    [remote], { uploadedCount: 0 }, localFiles,
  );
  return { localAdapter, setFile };
}

describe('[SPEC:MT-6] initial-sync seed loop (identical on both sides) does not touch the local mtime', () => {
  it('writes no content', async () => {
    const { localAdapter } = await runSeed(remoteOf());
    expect(localAdapter.atomicWrite).toHaveBeenCalledTimes(0);
    expect(localAdapter.atomicWriteBinary).toHaveBeenCalledTimes(0);
  });

  it('records the remote mtime in State', async () => {
    const { setFile } = await runSeed(remoteOf());
    expect(setFile).toHaveBeenCalledTimes(1);
    expect(setFile.mock.calls[0][0]).toMatchObject({ path: 'a.md', mtime: REMOTE_MTIME, remoteMtime: REMOTE_MTIME });
  });

  it('records the local mtime in State when the remote has no lastModified, still without a write', async () => {
    const { localAdapter, setFile } = await runSeed(remoteOf({ lastModified: undefined }));
    expect(localAdapter.atomicWrite).toHaveBeenCalledTimes(0);
    expect(localAdapter.atomicWriteBinary).toHaveBeenCalledTimes(0);
    expect(setFile.mock.calls[0][0]).toMatchObject({ path: 'a.md', mtime: LOCAL_MTIME });
  });
});
