import { SyncEngine } from '../../src/sync/SyncEngine';
import { DavSyncSettings, FileState, RemoteFileInfo, SyncSessionSummary } from '../../src/types';

/**
 * Config-folder conflict handling (FR-013): a conflicting config JSON file resolves by
 * newest-wins (mtime) and NEVER receives text conflict markers — even when the user's
 * conflictFailurePolicy is 'conflict-markers' — because markers would corrupt the JSON.
 */

const enc = new TextEncoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer;

const CONFIG_PATH = '.obsidian/appearance.json';

function makeSettings(): DavSyncSettings {
  return {
    serverUrl: '', username: '', passwordSecretId: '', syncIntervalMinutes: 0,
    networkTimeoutSeconds: 30, deviceId: 'dev-abcd', uploadChunkThresholdMB: 50,
    maxFileSizeMB: 1024, watchOnChangeEnabled: false, syncOnStartupEnabled: true,
    startupSyncDelaySeconds: 5, networkConcurrency: 8, syncOnWifiOnly: false,
    syncConfigFolder: true,
    configSync: { appearance: true, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: false },
    deviceName: '', logsFolder: '', syncLogEnabled: false, syncLogLevel: 'important',
    debugLogEnabled: false, debugLogLevel: 'error',
    chunkedUploadEnabled: true, fileLockingEnabled: false,
    autoMergeEnabled: true, maxConflictRegions: 10, frontmatterConflictStrategy: 'conflict',
    mergeableExtensions: ['md', 'txt'],
    // Deliberately the most dangerous policy: proves config files bypass markers.
    conflictFailurePolicy: 'conflict-markers',
    explorerCompareEnabled: false,
  };
}

function makeSummary(): SyncSessionSummary {
  return {
    startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0,
    deletedCount: 0, mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
  };
}

function buildHarness(localMtime: number, remoteMtime: number) {
  const setFile = jest.fn();
  const atomicWrite = jest.fn(async () => undefined);          // text write = conflict markers path
  const atomicWriteBinary = jest.fn(async () => undefined);    // prefer-remote path
  const setMtime = jest.fn(async () => undefined);
  const upload = jest.fn(async () => 'uploaded' as const);     // prefer-local path

  const localAdapter = {
    stat: jest.fn(async () => ({ size: 4, mtime: localMtime })),
    read: jest.fn(async () => 'local-json'),
    readBinary: jest.fn(async () => toBuf('local-json')),
    atomicWrite,
    atomicWriteBinary,
    setMtime,
    list: jest.fn(async () => ({ files: [], folders: [] })),
  };
  const stateDB = { setFile, getFile: jest.fn(() => undefined) };
  const client = {
    downloadFile: jest.fn(async () => undefined),
    getLastDownloadBuffer: jest.fn(() => toBuf('remote-json')),
  };

  const remote: RemoteFileInfo = {
    path: CONFIG_PATH, fileId: 'fid-1', checksum: 'rem', etag: 'etag-1', size: 4, lastModified: remoteMtime,
  };

  const opts = {
    app: {}, settings: makeSettings(), localAdapter, stateDB,
    statusBar: {}, webdavFactory: {}, pluginDir: '.obsidian/plugins/nextcloud-sync', configDir: '.obsidian',
  };
  const engine = new SyncEngine(opts as never);
  (engine as unknown as { client: unknown }).client = client;
  (engine as unknown as { uploadStrategy: unknown }).uploadStrategy = { upload };

  const invoke = (summary: SyncSessionSummary) =>
    (engine as unknown as {
      handleConflict(p: string, b: FileState | undefined, r: RemoteFileInfo, id: string, t: FileState['idType'], s: SyncSessionSummary): Promise<void>;
    }).handleConflict(CONFIG_PATH, undefined, remote, 'rem', 'sha256', summary);

  return { invoke, setFile, atomicWrite, atomicWriteBinary, upload };
}

describe('SyncEngine.handleConflict — config-folder newest-wins', () => {
  it('remote newer → pulls remote (no markers written)', async () => {
    const h = buildHarness(/* local */ 1000, /* remote */ 3000);
    const summary = makeSummary();
    await h.invoke(summary);

    expect(h.atomicWriteBinary).toHaveBeenCalledTimes(1); // local overwritten with remote
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.atomicWrite).not.toHaveBeenCalled();          // NO conflict-marker text write
    expect(summary.downloadedCount).toBe(1);
    expect(summary.conflictedCount).toBe(0);
    const arg = h.setFile.mock.calls[0][0] as FileState;
    expect(arg.isConflicted).toBe(false);
  });

  it('local newer → pushes local (no markers written)', async () => {
    const h = buildHarness(/* local */ 5000, /* remote */ 500);
    const summary = makeSummary();
    await h.invoke(summary);

    expect(h.upload).toHaveBeenCalledTimes(1);             // remote overwritten with local
    expect(h.atomicWriteBinary).not.toHaveBeenCalled();
    expect(h.atomicWrite).not.toHaveBeenCalled();          // NO conflict-marker text write
    expect(summary.uploadedCount).toBe(1);
    expect(summary.conflictedCount).toBe(0);
    const arg = h.setFile.mock.calls[0][0] as FileState;
    expect(arg.isConflicted).toBe(false);
  });

  it('equal mtime → remote-wins tiebreak (no markers)', async () => {
    const h = buildHarness(/* local */ 2000, /* remote */ 2000);
    const summary = makeSummary();
    await h.invoke(summary);

    expect(h.atomicWriteBinary).toHaveBeenCalledTimes(1);
    expect(h.atomicWrite).not.toHaveBeenCalled();
    expect(summary.downloadedCount).toBe(1);
  });
});
