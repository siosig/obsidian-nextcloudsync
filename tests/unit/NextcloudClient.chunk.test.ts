import { requestUrl, RequestUrlParam } from 'obsidian';
import { NextcloudClient } from '../../src/network/NextcloudClient';
import { DEFAULT_SETTINGS, DavSyncSettings } from '../../src/types';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

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
  beforeEach(() => mockRequestUrl.mockReset());

  it('creates a session, PUTs chunks by offset, and assembles via MOVE .file', async () => {
    // MKCOL→201, PUT(×3)→201, MOVE→201, verify PROPFIND→207(no checksum)
    mockRequestUrl.mockImplementation((req) => {
      if (req.method === 'PROPFIND') return Promise.resolve({ status: 207, text: '<d:multistatus/>', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });
      return ok(201);
    });

    const data = new ArrayBuffer(5); // 2バイトチャンク → offset 0,2,4 の3チャンク
    await new NextcloudClient(settings, 'pw', 'Vault').uploadChunked('Notes/big.bin', data, 2);

    // セッション作成 MKCOL（uploads 配下）が発行される。親ディレクトリ用 MKCOL も別途発行される。
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
