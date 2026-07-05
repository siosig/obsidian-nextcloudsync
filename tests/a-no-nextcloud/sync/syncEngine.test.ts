import { StateDB } from '../../../src/data/StateDB';
import { DavSyncSettings, DEFAULT_SETTINGS, FileState, RemoteFileInfo, SyncSessionSummary } from '../../../src/types';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { sha256 } from '../../../src/util/hash';

// Simplified 3-point comparison logic extracted for unit testing
function classify(
  base: FileState | undefined,
  localHash: string,
  remoteId: string,
): 'unchanged' | 'local-modified' | 'remote-modified' | 'conflicted' | 'new-remote' | 'new-local' {
  if (!base) {
    // file not in StateDB
    if (localHash && remoteId) return 'conflicted';
    if (localHash) return 'new-local';
    return 'new-remote';
  }
  const localChanged = localHash !== base.localHash;
  const remoteChanged = remoteId !== base.remoteId;
  if (!localChanged && !remoteChanged) return 'unchanged';
  if (localChanged && !remoteChanged) return 'local-modified';
  if (!localChanged && remoteChanged) return 'remote-modified';
  return 'conflicted';
}

describe('SyncEngine 3-point comparison', () => {
  const base: FileState = {
    path: 'notes.md', localHash: 'hash-a', remoteId: 'hash-a',
    idType: 'sha256', size: 100, mtime: 1000, remoteFileId: null, isConflicted: false,
  };

  it('unchanged when both match base', () => {
    expect(classify(base, 'hash-a', 'hash-a')).toBe('unchanged');
  });

  it('local-modified when only local changed', () => {
    expect(classify(base, 'hash-b', 'hash-a')).toBe('local-modified');
  });

  it('remote-modified when only remote changed', () => {
    expect(classify(base, 'hash-a', 'hash-c')).toBe('remote-modified');
  });

  it('conflicted when both changed', () => {
    expect(classify(base, 'hash-b', 'hash-c')).toBe('conflicted');
  });

  it('new-remote when no base and no local hash', () => {
    expect(classify(undefined, '', 'hash-x')).toBe('new-remote');
  });

  it('new-local when no base and no remote id', () => {
    expect(classify(undefined, 'hash-y', '')).toBe('new-local');
  });
});

describe('StateDB integration with SyncEngine logic', () => {
  function makeAdapter(files: Record<string, string> = {}) {
    const store = { ...files };
    return {
      read: jest.fn(async (p: string) => store[p] ?? ''),
      write: jest.fn(async (p: string, d: string) => { store[p] = d; }),
      readBinary: jest.fn(),
      writeBinary: jest.fn(),
      exists: jest.fn(async (p: string) => p in store),
      remove: jest.fn(async (p: string) => { delete store[p]; }),
      rename: jest.fn(async (from: string, to: string) => { store[to] = store[from]; delete store[from]; }),
      stat: jest.fn(),
      list: jest.fn(),
    };
  }

  it('detects conflicted files after setting isConflicted', async () => {
    const db = new StateDB(makeAdapter() as never, '.obsidian/plugins/test', 'dev-001');
    await db.load();
    db.setFile({ path: 'a.md', localHash: 'x', remoteId: 'x', idType: 'sha256', size: 10, mtime: 0, remoteFileId: null, isConflicted: true });
    expect(db.countConflicted()).toBe(1);
    // After resolution
    const f = db.getFile('a.md')!;
    db.setFile({ ...f, isConflicted: false });
    expect(db.countConflicted()).toBe(0);
  });
});

describe('SyncEngine.handleConflict — strategy actions (feature 037)', () => {
  const enc = new TextEncoder();
  const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer;

  // Feature 037: a per-type strategy decides every conflict. Each case sets the relevant strategy
  // (otherFileStrategy for image.png, or autoMergeFileTypes+autoMergeFileStrategy to route it to merge).
  function makeSettings(over: Partial<DavSyncSettings>): DavSyncSettings {
    return { ...DEFAULT_SETTINGS, deviceId: 'dev-abcd', ...over };
  }

  function makeSummary(): SyncSessionSummary {
    return {
      startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0,
      deletedCount: 0, mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
    };
  }

  const remote: RemoteFileInfo = {
    path: 'image.png', fileId: 'fid-1', checksum: 'rem-checksum', etag: 'etag-1',
    size: 6, lastModified: 2000,
  };

  function buildHarness(
    settingsOver: Partial<DavSyncSettings>, localContent: string, remoteContent: string,
    opts: { localMtime?: number; remoteMtime?: number } = {},
  ) {
    const localMtime = opts.localMtime ?? 1000;
    const remoteMtime = opts.remoteMtime ?? 2000;
    const setFile = jest.fn();
    const atomicWrite = jest.fn(async () => undefined);
    const atomicWriteBinary = jest.fn(async () => undefined);
    const setMtime = jest.fn(async () => undefined);
    const upload = jest.fn(async () => 'uploaded' as const);

    const localAdapter = {
      stat: jest.fn(async () => ({ size: enc.encode(localContent).byteLength, mtime: localMtime })),
      read: jest.fn(async () => localContent),
      readBinary: jest.fn(async () => toBuf(localContent)),
      atomicWrite,
      atomicWriteBinary,
      setMtime,
    };
    const setRemoteRootEtag = jest.fn();
    const stateDB = { setFile, getFile: jest.fn(() => undefined), setRemoteRootEtag };
    const client = {
      downloadFile: jest.fn(async () => toBuf(remoteContent)),
    };

    const opts2 = {
      app: {}, settings: makeSettings(settingsOver), localAdapter, stateDB,
      statusBar: {}, webdavFactory: {}, pluginDir: '', configDir: '.obsidian',
    };
    const engine = new SyncEngine(opts2 as never);
    (engine as unknown as { client: unknown }).client = client;
    (engine as unknown as { uploadStrategy: unknown }).uploadStrategy = { upload };

    // remote.size must match the body length so the spec-025 server-anomaly guard (advertised vs
    // received) does not refuse the prefer-remote overwrite in these conflict tests.
    const harnessRemote: RemoteFileInfo = {
      ...remote, size: enc.encode(remoteContent).byteLength, lastModified: remoteMtime,
    };
    const invoke = (base: FileState | undefined, summary: SyncSessionSummary) =>
      (engine as unknown as {
        handleConflict(p: string, b: FileState | undefined, r: RemoteFileInfo, id: string, t: FileState['idType'], s: SyncSessionSummary): Promise<void>;
      }).handleConflict('image.png', base, harnessRemote, 'rem-checksum', 'sha256', summary);

    return { engine, invoke, setFile, setRemoteRootEtag, atomicWrite, atomicWriteBinary, upload, client, localAdapter };
  }

  it('local-win → prefer-local: uploads local, marks both sides converged (localHash)', async () => {
    const h = buildHarness({ otherFileStrategy: 'local-win' }, 'local-text', 'remote-text');
    const summary = makeSummary();
    await h.invoke(undefined, summary);

    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.atomicWriteBinary).not.toHaveBeenCalled();
    expect(summary.uploadedCount).toBe(1);
    const arg = h.setFile.mock.calls[0][0] as FileState;
    expect(arg.isConflicted).toBe(false);
    expect(arg.localHash).toBe(arg.remoteId); // converged on the local content hash
    expect(arg.idType).toBe('sha256');
  });

  it('remote-win → prefer-remote: overwrites local with remote, marks converged', async () => {
    const h = buildHarness({ otherFileStrategy: 'remote-win' }, 'local-text', 'remote-text');
    const summary = makeSummary();
    await h.invoke(undefined, summary);

    expect(h.atomicWriteBinary).toHaveBeenCalledTimes(1);
    expect(h.upload).not.toHaveBeenCalled();
    expect(summary.downloadedCount).toBe(1);
    const arg = h.setFile.mock.calls[0][0] as FileState;
    expect(arg.isConflicted).toBe(false);
    expect(arg.remoteId).toBe('rem-checksum');
    // 051-webdav-cache-headers: forced prefer-remote resolution must fetch through the shared
    // client.downloadFile() (not a bespoke fetch), since that is the single choke point where
    // NO_CACHE_HEADERS is applied — proven separately in noCacheHeaders.test.ts.
    expect(h.client.downloadFile).toHaveBeenCalledWith('image.png');
  });

  it('latest-mtime → prefers the newer side (remote newer here → overwrites local)', async () => {
    const h = buildHarness({ otherFileStrategy: 'latest-mtime' }, 'local-text', 'remote-text',
      { localMtime: 1000, remoteMtime: 2000 });
    const summary = makeSummary();
    await h.invoke(undefined, summary);

    expect(h.atomicWriteBinary).toHaveBeenCalledTimes(1);
    expect(h.upload).not.toHaveBeenCalled();
    expect(summary.downloadedCount).toBe(1);
  });

  it('biggest-size → prefers the larger side (local larger here → uploads local)', async () => {
    const h = buildHarness({ otherFileStrategy: 'biggest-size' }, 'local-text-is-longer', 'remote');
    const summary = makeSummary();
    await h.invoke(undefined, summary);

    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.atomicWriteBinary).not.toHaveBeenCalled();
    expect(summary.uploadedCount).toBe(1);
  });

  it('tie (latest-mtime, equal mtime) → no-op: both sides untouched, not conflicted, not an error', async () => {
    const base: FileState = {
      path: 'image.png', localHash: 'lh', remoteId: 'rh', idType: 'sha256',
      size: 10, mtime: 1500, remoteFileId: 'fid-1', isConflicted: false,
    };
    const h = buildHarness({ otherFileStrategy: 'latest-mtime' }, 'local-text', 'remote-text',
      { localMtime: 1500, remoteMtime: 1500 });
    const summary = makeSummary();
    await h.invoke(base, summary);

    expect(h.upload).not.toHaveBeenCalled();
    expect(h.atomicWrite).not.toHaveBeenCalled();
    expect(h.atomicWriteBinary).not.toHaveBeenCalled();
    expect(summary.errorCount).toBe(0);
    expect(summary.conflictedCount).toBe(0);
    // StateDB untouched: the next sync re-evaluates the tie (self-healing).
    expect(h.setFile).not.toHaveBeenCalled();
    // ES-11: a tie leaves the sides DIVERGENT with no counter raised, so finalizeScan's convergence
    // gate cannot disarm the root-ETag short-circuit. The no-op must invalidate the stored root ETag
    // itself, or the next sync would rebuild from stale State and silently upload the local side over
    // the remote (data loss). Regression for conflictPolicyMatrix.b1 combo 1/5.
    expect(h.setRemoteRootEtag).toHaveBeenCalledWith(null);
  });

  it('merge on non-text → safe-hold: both sides untouched, flagged conflicted, NOT an error (FR-005a)', async () => {
    const base: FileState = {
      path: 'image.png', localHash: 'lh', remoteId: 'rh', idType: 'sha256',
      size: 10, mtime: 1000, remoteFileId: 'fid-1', isConflicted: false,
    };
    // png is routed to the merge strategy, but the bytes are binary (NUL) → safe-hold, no markers.
    const nul = String.fromCharCode(0);
    const h = buildHarness(
      { autoMergeFileTypes: ['png'], autoMergeFileStrategy: 'merge' },
      `local${nul}bin`, `remote${nul}bin`,
    );
    const summary = makeSummary();
    await h.invoke(base, summary);

    expect(h.upload).not.toHaveBeenCalled();
    expect(h.atomicWrite).not.toHaveBeenCalled();
    expect(h.atomicWriteBinary).not.toHaveBeenCalled();
    expect(summary.errorCount).toBe(0);
    expect(summary.conflictedCount).toBe(1);
    // Flagged conflicted, hashes unchanged so the divergence persists for manual resolution.
    expect(h.setFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'image.png', localHash: 'lh', remoteId: 'rh', isConflicted: true,
    }));
  });

  it('prefer-local upload failure → keeps conflict unresolved, counts error, no converged StateDB write', async () => {
    const h = buildHarness({ otherFileStrategy: 'local-win' }, 'local-text', 'remote-text');
    h.upload.mockRejectedValueOnce(new Error('network down'));
    const summary = makeSummary();
    await h.invoke(undefined, summary);

    expect(summary.errorCount).toBe(1);
    expect(summary.uploadedCount).toBe(0);
    expect(summary.errors[0]).toEqual({ path: 'image.png', message: 'network down' });
    // Must NOT record a converged (isConflicted:false) entry on failure.
    expect(h.setFile).not.toHaveBeenCalled();
  });

  // SC-004 self-healing: a latest-mtime tie is a non-destructive no-op and re-evaluates next sync —
  // once one side becomes newer, the same divergence resolves deterministically.
  it('SH self-healing: a latest-mtime tie is a no-op, then resolves once a side becomes newer', async () => {
    const base: FileState = {
      path: 'image.png', localHash: 'lh', remoteId: 'rh', idType: 'sha256',
      size: 10, mtime: 1500, remoteFileId: 'fid-1', isConflicted: false,
    };

    // 1st sync — equal mtime → no-op: nothing overwritten, not flagged, StateDB untouched.
    const tied = buildHarness({ otherFileStrategy: 'latest-mtime' }, 'local-text', 'remote-text',
      { localMtime: 1500, remoteMtime: 1500 });
    const s1 = makeSummary();
    await tied.invoke(base, s1);
    expect(tied.atomicWriteBinary).not.toHaveBeenCalled();
    expect(s1.errorCount).toBe(0);
    expect(tied.setFile).not.toHaveBeenCalled();

    // 2nd sync — remote is now newer; the same divergence resolves by overwriting local.
    const resolved = buildHarness({ otherFileStrategy: 'latest-mtime' }, 'local-text', 'remote-text',
      { localMtime: 1500, remoteMtime: 3000 });
    const s2 = makeSummary();
    await resolved.invoke(base, s2);
    expect(resolved.atomicWriteBinary).toHaveBeenCalledTimes(1);
    expect(s2.downloadedCount).toBe(1);
    expect((resolved.setFile.mock.calls[0][0] as FileState).isConflicted).toBe(false);
  });
});

describe('SyncEngine.processRemoteDeletion — out-of-scope safety', () => {
  function makeSummary(): SyncSessionSummary {
    return {
      startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0,
      deletedCount: 0, mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
    };
  }

  function buildHarness(getAbstractFile: (p: string) => unknown, opts: { bookmarks?: boolean } = {}) {
    const remove = jest.fn(async () => undefined);
    const trashFile = jest.fn(async () => undefined);
    const exists = jest.fn(async () => true);
    const getAbstractFileByPath = jest.fn((p: string) => getAbstractFile(p));
    const deleteFile = jest.fn();

    const app = {
      vault: { adapter: { exists, remove }, getAbstractFileByPath },
      fileManager: { trashFile },
    };
    const stateDB = { deleteFile };
    const bookmarks = opts.bookmarks ?? false;
    const settings = {
      configDir: '.obsidian',
      syncConfigFolder: bookmarks,
      configSync: { appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks },
    } as unknown;
    const engineOpts = {
      app, settings, stateDB, configDir: '.obsidian',
      localAdapter: {}, statusBar: {}, webdavFactory: {}, pluginDir: '.obsidian/plugins/nextcloud-sync',
    };
    const engine = new SyncEngine(engineOpts as never);
    const invoke = (path: string, summary: SyncSessionSummary) =>
      (engine as unknown as {
        processRemoteDeletion(p: string, s: SyncSessionSummary): Promise<void>;
      }).processRemoteDeletion(path, summary);

    return { invoke, remove, trashFile, exists, getAbstractFileByPath, deleteFile };
  }

  it('IGNORES a server-reported deletion that targets the Obsidian config folder (.obsidian/plugins/...)', async () => {
    // A malicious/compromised server could fabricate this deletion to destroy other plugins' code.
    const h = buildHarness(() => null);
    const summary = makeSummary();
    await h.invoke('.obsidian/plugins/some-plugin/main.js', summary);

    // The destructive sinks must never be reached for an out-of-scope path.
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.trashFile).not.toHaveBeenCalled();
    expect(h.getAbstractFileByPath).not.toHaveBeenCalled();
    expect(summary.downloadedCount).toBe(0);
  });

  it('also ignores deletion of the config folder root itself', async () => {
    const h = buildHarness(() => null);
    const summary = makeSummary();
    await h.invoke('.obsidian', summary);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.trashFile).not.toHaveBeenCalled();
  });

  it('still deletes an in-scope file that reaches the raw sink (regression: legitimate deletions work)', async () => {
    // Untracked file (getAbstractFileByPath → null) in a non-excluded location → raw remove proceeds.
    const h = buildHarness(() => null);
    const summary = makeSummary();
    await h.invoke('notes.md', summary);

    expect(h.remove).toHaveBeenCalledWith('notes.md');
    expect(h.deleteFile).toHaveBeenCalledWith('notes.md');
    expect(summary.downloadedCount).toBe(1);
  });

  it('processes bookmarks deletion only when the bookmarks config-sync category is enabled', async () => {
    // master + bookmarks category ON → bookmarks.json is in scope → deletion proceeds.
    const on = buildHarness(() => null, { bookmarks: true });
    const summaryOn = makeSummary();
    await on.invoke('.obsidian/bookmarks.json', summaryOn);
    expect(on.remove).toHaveBeenCalledTimes(1);

    // bookmarks OFF (master off) → excluded → ignored.
    const off = buildHarness(() => null, { bookmarks: false });
    const summaryOff = makeSummary();
    await off.invoke('.obsidian/bookmarks.json', summaryOff);
    expect(off.remove).not.toHaveBeenCalled();
  });
});

describe('SyncEngine.processRemoteFile — stale conflict-flag clearing', () => {
  function makeSummary(): SyncSessionSummary {
    return {
      startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0,
      deletedCount: 0, mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
    };
  }

  const remote: RemoteFileInfo = {
    path: 'note.md', fileId: 'fid-1', checksum: 'same-checksum', etag: 'etag-1',
    size: 12, lastModified: 1000,
  };

  function buildHarness(base: FileState) {
    const setFile = jest.fn();
    const localAdapter = {
      // The stat signature matches base.localMtime/localSize so the fast-path treats the file as
      // unchanged and does NOT recompute the hash → localChanged stays false.
      stat: jest.fn(async () => ({ size: base.size, mtime: base.mtime })),
      readBinary: jest.fn(async () => new ArrayBuffer(0)),
    };
    const stateDB = { getFile: jest.fn(() => base), setFile, getLastSyncTime: jest.fn(() => 0) };
    const opts = {
      app: {}, settings: {}, localAdapter, stateDB,
      statusBar: {}, webdavFactory: {}, pluginDir: '', configDir: '.obsidian',
    };
    const engine = new SyncEngine(opts as never);
    const invoke = (summary: SyncSessionSummary) =>
      (engine as unknown as {
        processRemoteFile(r: RemoteFileInfo, s: SyncSessionSummary): Promise<void>;
      }).processRemoteFile(remote, summary);
    return { invoke, setFile };
  }

  it('clears a stale isConflicted flag when an unchanged file has converged', async () => {
    const base: FileState = {
      path: 'note.md', localHash: 'lh', remoteId: 'same-checksum', idType: 'sha256',
      size: 12, mtime: 1000, remoteFileId: 'fid-1', isConflicted: true,
      localMtime: 1000, localSize: 12,
    };
    const h = buildHarness(base);
    await h.invoke(makeSummary());
    // The unchanged path must rewrite the entry with the conflict flag cleared.
    expect(h.setFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'note.md', isConflicted: false,
    }));
  });

  it('does not write when an unchanged file was never conflicted', async () => {
    const base: FileState = {
      path: 'note.md', localHash: 'lh', remoteId: 'same-checksum', idType: 'sha256',
      size: 12, mtime: 1000, remoteFileId: 'fid-1', isConflicted: false,
      localMtime: 1000, localSize: 12,
    };
    const h = buildHarness(base);
    await h.invoke(makeSummary());
    expect(h.setFile).not.toHaveBeenCalled();
  });
});

describe('SyncEngine.processRemoteFile — divergent (corrupt) baseline detection', () => {
  const enc = new TextEncoder();

  function makeSummary(): SyncSessionSummary {
    return {
      startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0,
      deletedCount: 0, mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
    };
  }

  // etag-only server (no content checksum) → idType resolves to 'etag'.
  const remote: RemoteFileInfo = {
    path: 'note.md', fileId: 'fid-1', checksum: null, etag: 'etag-1',
    size: 10600, lastModified: 1000,
  };

  function buildHarness(base: FileState, localData: ArrayBuffer, localSize: number, localMtime: number) {
    const setFile = jest.fn();
    const handleConflict = jest.fn(async () => undefined);
    const localAdapter = {
      stat: jest.fn(async () => ({ size: localSize, mtime: localMtime })),
      readBinary: jest.fn(async () => localData),
    };
    const stateDB = { getFile: jest.fn(() => base), setFile };
    const opts = {
      app: {}, settings: {}, localAdapter, stateDB,
      statusBar: {}, webdavFactory: {}, pluginDir: '', configDir: '.obsidian',
    };
    const engine = new SyncEngine(opts as never);
    (engine as unknown as { handleConflict: unknown }).handleConflict = handleConflict;
    const invoke = (summary: SyncSessionSummary) =>
      (engine as unknown as {
        processRemoteFile(r: RemoteFileInfo, s: SyncSessionSummary): Promise<void>;
      }).processRemoteFile(remote, summary);
    return { invoke, setFile, handleConflict };
  }

  it('reconciles via handleConflict when an etag baseline is internally inconsistent (size disagrees with the recorded hash)', async () => {
    // Reproduces the real bug: base.localHash matches the CURRENT local file,
    // remote etag is unchanged (remoteChanged=false), yet base.size records the
    // remote's size (10600) — so local(small) and remote(10600) genuinely differ.
    // The old code classified this "unchanged" and skipped it forever.
    const localData = enc.encode('short-local-content').buffer;
    const localHash = await sha256(localData);
    const base: FileState = {
      path: 'note.md', localHash, remoteId: 'etag-1', idType: 'etag',
      size: 10600, mtime: 1000, remoteFileId: 'fid-1', isConflicted: false,
    };
    // localStat.size (real local) != base.size; mtime not advanced.
    const h = buildHarness(base, localData, localData.byteLength, 1000);
    await h.invoke(makeSummary());

    expect(h.handleConflict).toHaveBeenCalledTimes(1);
  });

  it('does NOT reconcile a genuinely converged etag file (sizes agree)', async () => {
    const localData = enc.encode('converged-content').buffer;
    const localHash = await sha256(localData);
    const base: FileState = {
      path: 'note.md', localHash, remoteId: 'etag-1', idType: 'etag',
      size: localData.byteLength, mtime: 1000, remoteFileId: 'fid-1', isConflicted: false,
    };
    const remoteConverged: RemoteFileInfo = { ...remote, size: localData.byteLength };
    const setFile = jest.fn();
    const handleConflict = jest.fn(async () => undefined);
    const localAdapter = {
      stat: jest.fn(async () => ({ size: localData.byteLength, mtime: 1000 })),
      readBinary: jest.fn(async () => localData),
    };
    const stateDB = { getFile: jest.fn(() => base), setFile };
    const engine = new SyncEngine({
      app: {}, settings: {}, localAdapter, stateDB,
      statusBar: {}, webdavFactory: {}, pluginDir: '', configDir: '.obsidian',
    } as never);
    (engine as unknown as { handleConflict: unknown }).handleConflict = handleConflict;
    await (engine as unknown as {
      processRemoteFile(r: RemoteFileInfo, s: SyncSessionSummary): Promise<void>;
    }).processRemoteFile(remoteConverged, makeSummary());

    expect(handleConflict).not.toHaveBeenCalled();
  });
});
