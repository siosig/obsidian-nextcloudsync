import { requestUrl } from 'obsidian';
import { NextcloudClient } from '../../src/network/NextcloudClient';
import { DEFAULT_SETTINGS, DavSyncSettings, FileLockedError } from '../../src/types';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

function res(status: number, headers: Record<string, string> = {}) {
  return Promise.resolve({ status, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers });
}

const settings: DavSyncSettings = {
  ...DEFAULT_SETTINGS,
  serverUrl: 'https://nc/remote.php/dav/files/alice/',
  username: 'alice',
  deviceId: 'dev-1',
};

function makeClient(): NextcloudClient {
  return new NextcloudClient(settings, 'pw', 'Vault');
}

describe('NextcloudClient locking', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  it('lockFile returns the token from the Lock-Token header', async () => {
    mockRequestUrl.mockReturnValueOnce(res(200, { 'lock-token': 'opaquelocktoken:abc' }));
    const token = await makeClient().lockFile('Notes/a.md');
    expect(token).toBe('opaquelocktoken:abc');
    const call = mockRequestUrl.mock.calls[0][0];
    expect(call.method).toBe('LOCK');
    expect(call.headers?.['X-User-Lock']).toBe('1');
  });

  it('lockFile throws FileLockedError on HTTP 423', async () => {
    mockRequestUrl.mockReturnValueOnce(res(423));
    await expect(makeClient().lockFile('Notes/a.md')).rejects.toBeInstanceOf(FileLockedError);
  });

  it('unlockFile issues UNLOCK with the token', async () => {
    mockRequestUrl.mockReturnValueOnce(res(204));
    await makeClient().unlockFile('Notes/a.md', 'opaquelocktoken:abc');
    const call = mockRequestUrl.mock.calls[0][0];
    expect(call.method).toBe('UNLOCK');
    expect(call.headers?.['Lock-Token']).toBe('opaquelocktoken:abc');
  });

  it('unlockFile swallows errors (best effort)', async () => {
    mockRequestUrl.mockRejectedValueOnce(new Error('network down'));
    await expect(makeClient().unlockFile('Notes/a.md', 'tok')).resolves.toBeUndefined();
  });
});
