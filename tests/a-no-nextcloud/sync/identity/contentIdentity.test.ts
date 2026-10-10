import { RemoteFileInfo } from '../../../../src/types';
import { bytesEqual, checksumProvesIdentical, convergedState } from '../../../../src/sync/identity/contentIdentity';

const remoteOf = (over: Partial<RemoteFileInfo> = {}): RemoteFileInfo => ({
  path: 'a/b.md', fileId: 'fid-1', checksum: null, etag: null, size: 3, lastModified: 0, ...over,
});

const buf = (...bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer;

describe('checksumProvesIdentical', () => {
  it('is false when the remote checksum is null', () => {
    expect(checksumProvesIdentical({ checksum: null }, 'abc')).toBe(false);
  });
  it('is false when the local hash is empty', () => {
    expect(checksumProvesIdentical({ checksum: 'abc' }, '')).toBe(false);
  });
  it('is false when the checksum and the hash differ', () => {
    expect(checksumProvesIdentical({ checksum: 'abc' }, 'abd')).toBe(false);
  });
  it('is true when the checksum and the hash match', () => {
    expect(checksumProvesIdentical({ checksum: 'abc' }, 'abc')).toBe(true);
  });
});

describe('bytesEqual', () => {
  it('is false when the lengths differ', () => {
    expect(bytesEqual(buf(1, 2, 3), buf(1, 2))).toBe(false);
  });
  it('is false when one byte differs at the same length', () => {
    expect(bytesEqual(buf(1, 2, 3), buf(1, 9, 3))).toBe(false);
  });
  it('is true for the same content', () => {
    expect(bytesEqual(buf(1, 2, 3), buf(1, 2, 3))).toBe(true);
  });
  it('is true for two empty buffers', () => {
    expect(bytesEqual(buf(), buf())).toBe(true);
  });
});

describe('convergedState', () => {
  const stat = { size: 3, mtime: 55 };

  it('uses the checksum as the remote id when present', () => {
    const s = convergedState(remoteOf({ checksum: 'abc', etag: 'e1' }), 'abc', stat);
    expect(s.remoteId).toBe('abc');
    expect(s.idType).toBe('sha256');
  });
  it('falls back to the etag when there is no checksum', () => {
    const s = convergedState(remoteOf({ checksum: null, etag: 'e1' }), 'h', stat);
    expect(s.remoteId).toBe('e1');
    expect(s.idType).toBe('etag');
  });
  it('falls back to the size when there is neither checksum nor etag', () => {
    const s = convergedState(remoteOf({ checksum: null, etag: null, size: 7 }), 'h', stat);
    expect(s.remoteId).toBe('7');
    expect(s.idType).toBe('size');
  });
  it('takes the local mtime when the remote lastModified is 0', () => {
    expect(convergedState(remoteOf({ lastModified: 0 }), 'h', stat).mtime).toBe(55);
  });
  it('takes the remote lastModified when it is set', () => {
    expect(convergedState(remoteOf({ lastModified: 9000 }), 'h', stat).mtime).toBe(9000);
  });
  it('always carries the local size, the hash, a clear conflict flag and the remote file id', () => {
    const remote = remoteOf({ checksum: 'abc', size: 99, fileId: 'fid-42' });
    const s = convergedState(remote, 'abc', stat);
    expect(s.size).toBe(stat.size);
    expect(s.localHash).toBe('abc');
    expect(s.isConflicted).toBe(false);
    expect(s.remoteFileId).toBe(remote.fileId);
    expect(s.path).toBe(remote.path);
  });
});
