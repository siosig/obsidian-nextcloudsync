import { reconcileFileTimes, timeDirection } from '../../../src/sync/identity/fileTimes';
import { FileState, RemoteFileInfo } from '../../../src/types';
import { IWebDAVClient } from '../../../src/network/IWebDAVClient';

const BIRTH = 1577808000000;
const MODIFIED = 1646092800000;
const base: FileState = { path: 'note.md', localHash: 'abc', remoteId: 'abc', idType: 'sha256', size: 5,
  mtime: MODIFIED, remoteFileId: '1', isConflicted: false, localMtime: MODIFIED, remoteMtime: MODIFIED,
  localCtime: BIRTH, remoteCtime: BIRTH };
const file = (): RemoteFileInfo => ({ path: 'note.md', fileId: '1', checksum: 'abc', etag: 'etag', size: 5,
  lastModified: MODIFIED, creationTime: BIRTH });

test('timestamp direction uses baselines, ignores subsecond rounding, and rejects concurrent changes', () => {
  expect(timeDirection(BIRTH + 999, BIRTH)).toBe('same');
  expect(timeDirection(BIRTH + 1000, BIRTH, BIRTH, BIRTH)).toBe('push');
  expect(timeDirection(BIRTH, BIRTH + 1000, BIRTH, BIRTH)).toBe('pull');
  expect(timeDirection(BIRTH + 1000, BIRTH)).toBe('pull');
  expect(() => timeDirection(BIRTH + 1000, BIRTH + 2000, BIRTH, BIRTH)).toThrow('Both sides changed');
});

function ports(remote: RemoteFileInfo, localTimes = { ctime: BIRTH, mtime: MODIFIED }) {
  const local = { stat: jest.fn(async () => ({ size: 5, ...localTimes })), setFileTimes: jest.fn(async () => undefined) };
  const client = { statFile: jest.fn(async () => ({ ...remote })),
    setFileTimes: jest.fn(async (_: string, times: { ctime: number; mtime: number }) => ({ ...remote, creationTime: times.ctime, lastModified: times.mtime, etag: 'new' })) };
  return { local, client, webdav: client as unknown as IWebDAVClient };
}

test('local creation-time-only change is pushed with optimistic concurrency, without a content transfer', async () => {
  const remote = file(); const p = ports(remote, { ctime: BIRTH + 86400000, mtime: MODIFIED });
  await reconcileFileTimes(p.local, p.webdav, remote, base);
  expect(p.client.setFileTimes).toHaveBeenCalledWith('note.md', { ctime: BIRTH + 86400000, mtime: MODIFIED }, 'etag');
  expect(p.local.setFileTimes).not.toHaveBeenCalled();
  expect(remote.creationTime).toBe(BIRTH + 86400000);
});

test('remote creation-time-only change is pulled while modification time stays unchanged', async () => {
  const remote = { ...file(), creationTime: BIRTH + 86400000 }; const p = ports(remote);
  await reconcileFileTimes(p.local, p.webdav, remote, base);
  expect(p.local.setFileTimes).toHaveBeenCalledWith('note.md', { ctime: BIRTH + 86400000, mtime: MODIFIED });
  expect(p.client.setFileTimes).not.toHaveBeenCalled();
});

test('independent mtime and ctime changes converge field by field', async () => {
  const remote = { ...file(), creationTime: BIRTH + 86400000 };
  const p = ports(remote, { ctime: BIRTH, mtime: MODIFIED + 86400000 });
  await reconcileFileTimes(p.local, p.webdav, remote, base);
  const wanted = { ctime: BIRTH + 86400000, mtime: MODIFIED + 86400000 };
  expect(p.client.setFileTimes).toHaveBeenCalledWith('note.md', wanted, 'etag');
  expect(p.local.setFileTimes).toHaveBeenCalledWith('note.md', wanted);
});

test('ambiguous timestamps and a changed remote body leave both sides untouched', async () => {
  const remote = { ...file(), creationTime: BIRTH + 1000 }; const p = ports(remote, { ctime: BIRTH + 2000, mtime: MODIFIED });
  await expect(reconcileFileTimes(p.local, p.webdav, remote, base)).rejects.toThrow('Both sides changed');
  expect(p.local.setFileTimes).not.toHaveBeenCalled(); expect(p.client.setFileTimes).not.toHaveBeenCalled();
  p.client.statFile.mockResolvedValue({ ...remote, checksum: 'different' });
  await expect(reconcileFileTimes(p.local, p.webdav, remote, base)).rejects.toThrow('Remote content changed');
});


test('missing fresh checksum and an invalidated ETag cannot prove unchanged content', async () => {
  const remote = file();
  const p = ports(remote, { ctime: BIRTH + 1000, mtime: MODIFIED });
  p.client.statFile.mockResolvedValue({ ...remote, checksum: null, etag: 'changed' });
  await expect(reconcileFileTimes(p.local, p.webdav, remote, base)).rejects.toThrow('Remote content changed');
  expect(p.local.setFileTimes).not.toHaveBeenCalled();
  expect(p.client.setFileTimes).not.toHaveBeenCalled();
});
