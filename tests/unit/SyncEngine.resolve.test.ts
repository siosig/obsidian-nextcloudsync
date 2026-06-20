import { SyncEngine } from '../../src/sync/SyncEngine';
import { RemoteFileInfo } from '../../src/types';

function buf(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

function remoteInfo(path: string, over: Partial<RemoteFileInfo> = {}): RemoteFileInfo {
  return { path, fileId: 'fid', checksum: null, etag: 'e', size: 6, lastModified: 222000, ...over };
}

interface Cfg {
  localContent?: string;
  localStat?: { size: number; mtime: number } | null;
  remote?: RemoteFileInfo | null;
  remoteContent?: string;
  uploadThrows?: boolean;
  downloadThrows?: boolean;
  uploadOutcome?: 'uploaded' | 'skipped';
}

function makeEngine(cfg: Cfg) {
  const client = {
    getFiles: jest.fn(async () => (cfg.remote === undefined ? [remoteInfo('a.md')] : cfg.remote ? [cfg.remote] : [])),
    downloadFile: jest.fn(async () => {
      if (cfg.downloadThrows) throw new Error('download boom');
      return buf(cfg.remoteContent ?? 'remote');
    }),
  };

  const uploadStrategy = {
    upload: jest.fn(async () => {
      if (cfg.uploadThrows) throw new Error('upload boom');
      return cfg.uploadOutcome ?? 'uploaded';
    }),
  };

  const record = jest.fn();
  const historyStore = { record, save: jest.fn(async () => {}) };
  const stateDB = { setFile: jest.fn(), save: jest.fn(async () => {}) };

  const localAdapter = {
    stat: jest.fn(async () => (cfg.localStat === undefined ? { size: 5, mtime: 111000 } : cfg.localStat)),
    readBinary: jest.fn(async () => buf(cfg.localContent ?? 'local')),
    atomicWriteBinary: jest.fn(async (_path: string, _data: ArrayBuffer) => {}),
    setMtime: jest.fn(async (_path: string, _mtime: number) => {}),
  };

  const engine = new SyncEngine({
    settings: { mergeableExtensions: ['md', 'txt'], fileLockingEnabled: false },
    localAdapter, stateDB, historyStore,
  } as never);
  (engine as unknown as { client: unknown }).client = client;
  (engine as unknown as { features: unknown }).features = { hasFilesLocking: false };
  (engine as unknown as { uploadStrategy: unknown }).uploadStrategy = uploadStrategy;

  return { engine, client, uploadStrategy, record, historyStore, stateDB, localAdapter };
}

describe('SyncEngine.pushLocalToRemote', () => {
  test('P1: success uploads local bytes, records uploaded, saves', async () => {
    const { engine, uploadStrategy, record, historyStore, stateDB } = makeEngine({ remote: remoteInfo('a.md') });
    await engine.pushLocalToRemote('a.md');
    expect(uploadStrategy.upload).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith('a.md', 'uploaded', expect.any(Number), undefined, expect.any(Object), expect.any(Number));
    expect(stateDB.setFile).toHaveBeenCalledTimes(1);
    expect(historyStore.save).toHaveBeenCalled();
  });

  test('P2: upload failure rejects and records nothing', async () => {
    const { engine, record, stateDB } = makeEngine({ remote: remoteInfo('a.md'), uploadThrows: true });
    await expect(engine.pushLocalToRemote('a.md')).rejects.toThrow();
    expect(record).not.toHaveBeenCalled();
    expect(stateDB.setFile).not.toHaveBeenCalled();
  });

  test('P2b: a skipped (size-limit) upload rejects and records nothing', async () => {
    const { engine, record } = makeEngine({ remote: remoteInfo('a.md'), uploadOutcome: 'skipped' });
    await expect(engine.pushLocalToRemote('a.md')).rejects.toThrow();
    expect(record).not.toHaveBeenCalled();
  });
});

describe('SyncEngine.pullRemoteToLocal', () => {
  test('L1: success writes remote bytes locally, records downloaded, saves', async () => {
    const { engine, localAdapter, record, historyStore, stateDB } = makeEngine({ remote: remoteInfo('a.md'), remoteContent: 'pulled' });
    await engine.pullRemoteToLocal('a.md');
    // atomicWriteBinary is the plugin-owned write path (it registers an ignore so the modify
    // watcher does not echo the write back as an upload) — L3.
    expect(localAdapter.atomicWriteBinary).toHaveBeenCalledTimes(1);
    const [writtenPath] = localAdapter.atomicWriteBinary.mock.calls[0];
    expect(writtenPath).toBe('a.md');
    expect(record).toHaveBeenCalledWith('a.md', 'downloaded', expect.any(Number), undefined, expect.any(Object), expect.any(Number));
    expect(stateDB.setFile).toHaveBeenCalledTimes(1);
    expect(historyStore.save).toHaveBeenCalled();
  });

  test('L2: download failure rejects, local unchanged, records nothing', async () => {
    const { engine, localAdapter, record } = makeEngine({ remote: remoteInfo('a.md'), downloadThrows: true });
    await expect(engine.pullRemoteToLocal('a.md')).rejects.toThrow();
    expect(localAdapter.atomicWriteBinary).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  test('rejects when the remote file does not exist', async () => {
    const { engine, localAdapter } = makeEngine({ remote: null });
    await expect(engine.pullRemoteToLocal('a.md')).rejects.toThrow();
    expect(localAdapter.atomicWriteBinary).not.toHaveBeenCalled();
  });
});
