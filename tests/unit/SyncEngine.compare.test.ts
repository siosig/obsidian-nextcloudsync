import { SyncEngine } from '../../src/sync/SyncEngine';
import { RemoteFileInfo } from '../../src/types';

function buf(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

function remoteInfo(path: string, over: Partial<RemoteFileInfo> = {}): RemoteFileInfo {
  return { path, fileId: 'fid', checksum: null, etag: 'e', size: 10, lastModified: 222000, ...over };
}

interface Cfg {
  localStat?: { size: number; mtime: number } | null;
  localContent?: string;
  remote?: RemoteFileInfo | null;
  remoteContent?: string;
  downloadThrows?: boolean;
  getFilesThrows?: boolean;
}

function makeEngine(cfg: Cfg) {
  const localBuffer = buf(cfg.localContent ?? '');

  const client = {
    getFiles: jest.fn(async () => {
      if (cfg.getFilesThrows) throw new Error('propfind boom');
      return cfg.remote ? [cfg.remote] : [];
    }),
    downloadFile: jest.fn(async () => {
      if (cfg.downloadThrows) throw new Error('download boom');
      return buf(cfg.remoteContent ?? '');
    }),
  };

  const localAdapter = {
    stat: jest.fn(async () => (cfg.localStat === undefined ? { size: 5, mtime: 111000 } : cfg.localStat)),
    readBinary: jest.fn(async () => localBuffer),
  };

  const engine = new SyncEngine({
    settings: { mergeableExtensions: ['md', 'txt'], fileLockingEnabled: false },
    localAdapter,
  } as never);
  (engine as unknown as { client: unknown }).client = client;
  (engine as unknown as { features: unknown }).features = { hasFilesLocking: false };

  return { engine, client, localAdapter };
}

describe('SyncEngine.compareWithRemote', () => {
  test('C1: identical content → checksumMatch true, diffAvailable true, texts equal', async () => {
    const { engine } = makeEngine({ localContent: 'same\nbody', remote: remoteInfo('a.md'), remoteContent: 'same\nbody' });
    const r = await engine.compareWithRemote('a.md');
    expect(r.state).toBe('ok');
    expect(r.checksumMatch).toBe(true);
    expect(r.diffAvailable).toBe(true);
    expect(r.localText).toBe(r.remoteText);
  });

  test('C2: differing content → checksumMatch false, texts differ', async () => {
    const { engine } = makeEngine({ localContent: 'local', remote: remoteInfo('a.md'), remoteContent: 'remote' });
    const r = await engine.compareWithRemote('a.md');
    expect(r.state).toBe('ok');
    expect(r.checksumMatch).toBe(false);
    expect(r.localText).not.toBe(r.remoteText);
  });

  test('C3: remote 404 (getFiles empty) → remote-missing', async () => {
    const { engine } = makeEngine({ localContent: 'x', remote: null });
    const r = await engine.compareWithRemote('a.md');
    expect(r.state).toBe('remote-missing');
    expect(r.remoteExists).toBe(false);
    expect(r.checksumMatch).toBe(false);
  });

  test('C4: download error → state=error, message set, no throw', async () => {
    const { engine } = makeEngine({ localContent: 'x', remote: remoteInfo('a.md'), downloadThrows: true });
    const r = await engine.compareWithRemote('a.md');
    expect(r.state).toBe('error');
    expect(r.errorMessage).toBeTruthy();
  });

  test('C5: binary/non-text → diffAvailable false but checksums present', async () => {
    const { engine } = makeEngine({ localContent: 'PNGDATA', remote: remoteInfo('img.png'), remoteContent: 'PNGDATA2' });
    const r = await engine.compareWithRemote('img.png');
    expect(r.diffAvailable).toBe(false);
    expect(r.localText).toBeNull();
    expect(r.remoteText).toBeNull();
    expect(r.localChecksum).toBeTruthy();
    expect(r.remoteChecksum).toBeTruthy();
    expect(r.checksumMatch).toBe(false);
  });

  test('C6: local-only file → remote-missing with local metadata', async () => {
    const { engine } = makeEngine({ localStat: { size: 9, mtime: 333000 }, localContent: 'only-local', remote: null });
    const r = await engine.compareWithRemote('a.md');
    expect(r.state).toBe('remote-missing');
    expect(r.localExists).toBe(true);
    expect(r.localMtime).toBe(333000);
    expect(r.localChecksum).toBeTruthy();
  });
});
