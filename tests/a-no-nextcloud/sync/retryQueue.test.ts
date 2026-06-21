import { SyncEngine } from '../../../src/sync/SyncEngine';
import { NetworkError, RemoteFileInfo, SyncSessionSummary } from '../../../src/types';

// [SPEC:RT-1] docs/spec.md §6.3 retryQueue — a transient (network) failure on a remote file does not
// abort the session: the path is queued for retry and the error is recorded, while a non-transient
// local I/O error is recorded but NOT queued (retrying it would just fail again). The queue is an
// in-memory array drained each run (never persisted). This exercises the real processFileWithRetry
// wiring; previously the retryQueue mechanism had no test at any layer.

const remote: RemoteFileInfo = {
  path: 'note.md', fileId: 'fid-1', checksum: 'c', etag: 'e', size: 1, lastModified: 0,
};

function makeSummary(): SyncSessionSummary {
  return {
    startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0,
    deletedCount: 0, mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
  };
}

function buildEngine() {
  const opts = {
    app: {}, settings: {}, localAdapter: {}, stateDB: {},
    statusBar: {}, webdavFactory: {}, pluginDir: '', configDir: '.obsidian',
  };
  return new SyncEngine(opts as never);
}

type Privates = {
  processRemoteFile: (r: RemoteFileInfo, s: SyncSessionSummary) => Promise<void>;
  processFileWithRetry: (r: RemoteFileInfo, s: SyncSessionSummary) => Promise<void>;
  retryQueue: string[];
};

describe('[SPEC:RT-1] SyncEngine.processFileWithRetry — retry queue enqueue policy', () => {
  it('a NetworkError queues the path for retry and records the error (session continues)', async () => {
    const engine = buildEngine();
    const p = engine as unknown as Privates;
    p.processRemoteFile = jest.fn(async () => { throw new NetworkError(503, 'service unavailable'); });
    const summary = makeSummary();

    await expect(p.processFileWithRetry(remote, summary)).resolves.toBeUndefined(); // never throws
    expect(p.retryQueue).toContain('note.md');
    expect(summary.errorCount).toBe(1);
    expect(summary.errors[0].path).toBe('note.md');
  });

  it('a non-network (local I/O) error is recorded but NOT queued for retry', async () => {
    const engine = buildEngine();
    const p = engine as unknown as Privates;
    p.processRemoteFile = jest.fn(async () => { throw new Error('ENOENT: no such file'); });
    const summary = makeSummary();

    await expect(p.processFileWithRetry(remote, summary)).resolves.toBeUndefined();
    expect(p.retryQueue).not.toContain('note.md');
    expect(summary.errorCount).toBe(1);
  });

  it('the retry queue starts empty and is a plain in-memory array (not persisted state)', () => {
    const engine = buildEngine();
    const p = engine as unknown as Privates;
    expect(p.retryQueue).toEqual([]);
  });
});
