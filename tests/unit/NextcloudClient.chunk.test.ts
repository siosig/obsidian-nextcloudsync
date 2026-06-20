import { requestUrl, RequestUrlParam } from 'obsidian';
import { NextcloudClient } from '../../src/network/NextcloudClient';
import { DEFAULT_SETTINGS, DavSyncSettings } from '../../src/types';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

// Track sha256 call count via jest.mock factory.
let sha256CallCount = 0;
jest.mock('../../src/util/hash', () => ({
  sha256: async (data: ArrayBuffer) => {
    sha256CallCount++;
    // Compute real hash via crypto.subtle so checksum values remain valid.
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  },
}));

function ok(status = 201) {
  return Promise.resolve({ status, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });
}

const settings: DavSyncSettings = {
  ...DEFAULT_SETTINGS,
  serverUrl: 'https://nc/remote.php/dav/files/alice/',
  username: 'alice',
  deviceId: 'device-abcd1234',
};

function methodsOf(method: string): RequestUrlParam[] {
  return mockRequestUrl.mock.calls.map(c => c[0]).filter(r => r.method === method);
}

describe('NextcloudClient.uploadChunked', () => {
  beforeEach(() => {
    mockRequestUrl.mockReset();
    sha256CallCount = 0;
  });

  it('creates a session, PUTs chunks by offset, and assembles via MOVE .file', async () => {
    // MKCOL→201, PUT(×3)→201, MOVE→201, verify PROPFIND→207(no checksum)
    mockRequestUrl.mockImplementation((req) => {
      if (req.method === 'PROPFIND') return Promise.resolve({ status: 207, text: '<d:multistatus/>', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });
      return ok(201);
    });

    const data = new ArrayBuffer(5); // 2-byte chunks → 3 chunks at offsets 0, 2, 4
    await new NextcloudClient(settings, 'pw', 'Vault').uploadChunked('Notes/big.bin', data, 2);

    // The session-creation MKCOL (under uploads) is issued. A separate MKCOL for the parent directory is also issued.
    expect(methodsOf('MKCOL').some(c => c.url.includes('/uploads/alice/'))).toBe(true);
    const puts = methodsOf('PUT');
    expect(puts).toHaveLength(3);
    expect(puts[0].url).toContain('/000000000000000');
    expect(puts[1].url).toContain('/000000000000002');
    expect(puts[2].url).toContain('/000000000000004');

    const moves = methodsOf('MOVE');
    expect(moves).toHaveLength(1);
    expect(moves[0].url).toContain('/.file');
    expect(moves[0].headers?.['OC-Total-Length']).toBe('5');
    expect(moves[0].headers?.Destination).toContain('/Vault/Notes/big.bin');
  });

  it('computes sha256 exactly once per chunked upload even when server returns a remote checksum', async () => {
    // The critical case: PROPFIND returns a SHA256 checksum so verifyRemoteChecksum
    // has to compare local vs remote. Without the fix, sha256(data) is called again
    // inside verifyRemoteChecksum, making the total 2. After the fix it must stay 1.
    const data = new ArrayBuffer(5); // 2-byte chunks → 3 chunks at offsets 0, 2, 4
    // Pre-compute the expected hash so we can feed it back as the "remote" checksum.
    const expectedHash = await crypto.subtle.digest('SHA-256', data)
      .then(b => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join(''));

    mockRequestUrl.mockImplementation((req) => {
      if (req.method === 'PROPFIND') {
        return Promise.resolve({
          status: 207,
          text: `<d:multistatus><oc:checksums>SHA256:${expectedHash}</oc:checksums></d:multistatus>`,
          json: {}, arrayBuffer: new ArrayBuffer(0), headers: {},
        });
      }
      return ok(201);
    });

    await new NextcloudClient(settings, 'pw', 'Vault').uploadChunked('Notes/big.bin', data, 2);

    // sha256 must be called exactly once — OC-Checksum header only;
    // verifyRemoteChecksum reuses the precomputed sum without recomputing.
    expect(sha256CallCount).toBe(1);
  });

  it('deletes the session and rethrows on chunk failure', async () => {
    mockRequestUrl.mockImplementation((req) => {
      if (req.method === 'MKCOL') return ok(201);
      if (req.method === 'PUT') return Promise.resolve({ status: 500, text: 'err', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });
      return ok(201);
    });

    const data = new ArrayBuffer(4);
    await expect(
      new NextcloudClient(settings, 'pw', 'Vault').uploadChunked('Notes/big.bin', data, 2),
    ).rejects.toThrow();

    expect(methodsOf('DELETE').length).toBeGreaterThanOrEqual(1);
  });
});
