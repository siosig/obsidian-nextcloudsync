// [SPEC:PWR-1] One definition of a file's remote identity. Pinned so the rule is never hand-written in
// several places again, with a different rule deciding what to record after an upload.
import { remoteIdOf } from '../../../src/sync/remoteIdentity';
import { RemoteFileInfo } from '../../../src/types';

const remote = (over: Partial<RemoteFileInfo>): RemoteFileInfo => ({
  path: 'n.md', fileId: null, checksum: null, etag: null, size: 42, lastModified: 0, ...over,
});

describe('[SPEC:PWR-1] remoteIdOf', () => {
  it('prefers the checksum when the server provides one', () => {
    expect(remoteIdOf(remote({ checksum: 'abc', etag: '"e"' })))
      .toEqual({ remoteId: 'abc', idType: 'sha256' });
  });

  it('falls back to the validator when there is no checksum', () => {
    // The plain-WebDAV case: StandardWebDAVClient never sets a checksum, so this is the branch every
    // file on such a server takes.
    expect(remoteIdOf(remote({ etag: '"e"' }))).toEqual({ remoteId: '"e"', idType: 'etag' });
  });

  it('falls back to the size, and says so', () => {
    // An earlier copy labelled this branch 'etag' while using the size as the value; pinned here.
    expect(remoteIdOf(remote({}))).toEqual({ remoteId: '42', idType: 'size' });
  });

  it('treats an empty checksum as absent rather than as an identity', () => {
    expect(remoteIdOf(remote({ checksum: '', etag: '"e"' })))
      .toEqual({ remoteId: '"e"', idType: 'etag' });
  });
});
