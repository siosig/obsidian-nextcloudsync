import { requestUrl } from 'obsidian';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { DEFAULT_SETTINGS, DavSyncSettings } from '../../../src/types';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

const settings: DavSyncSettings = {
  ...DEFAULT_SETTINGS,
  serverUrl: 'https://nc/remote.php/dav/files/alice/',
  username: 'alice',
  deviceId: 'device-abcd1234',
};

const res = (status: number, headers: Record<string, string> = {}) =>
  Promise.resolve({ status, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers });

const client = () => new NextcloudClient(settings, 'pw', 'Vault');

// [SPEC:NET-3] feature 067 (issue #34 follow-up): NextcloudClient.reqReadonly() retries a transient
// req() rejection (timeout / connection failure) up to 2x, but ONLY for read-only PROPFIND/GET
// requests. req() only rejects when no HTTP response was received at all — any status code (incl.
// 401/404/415) resolves normally, so a rejection reaching reqReadonly is always transient by
// construction. Write requests (PUT/DELETE/MOVE/MKCOL/PATCH/LOCK/UNLOCK) never retry here, because a
// timed-out write may already have succeeded server-side — blindly retrying risks double-processing
// or a false MOVE-source-missing error. The REPORT-based getChanges()/getSyncToken() calls are also
// explicitly OUT of scope (semantically read-only, but the agreed 070 scope is PROPFIND/GET only; the
// full-scan PROPFIND fallback already covers the functional gap).
describe('NextcloudClient — read-only retry on transient req() rejection (feature 067)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRequestUrl.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('statFile (PROPFIND) retries once after a transient rejection and returns success', async () => {
    let calls = 0;
    mockRequestUrl.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('timeout'));
      return res(404); // resolved (not rejected) — statFile treats 404 as "not found" -> null
    });

    const promise = client().statFile('Notes/a.md');
    promise.catch(() => undefined);

    await jest.advanceTimersByTimeAsync(1000); // first backoff delay elapses -> retry fires

    await expect(promise).resolves.toBeNull();
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });

  it('getFiles (PROPFIND) retries once after a transient rejection and returns success', async () => {
    let calls = 0;
    mockRequestUrl.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('timeout'));
      return res(404); // resolved -> getFiles treats 404 (missing base folder) as an empty listing
    });

    const promise = client().getFiles('');
    promise.catch(() => undefined);

    await jest.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toEqual([]);
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });

  it('statFile (PROPFIND) exhausts retries (3 total attempts) and rethrows the original error', async () => {
    mockRequestUrl.mockImplementation(() => Promise.reject(new Error('timeout')));

    const promise = client().statFile('Notes/a.md');
    promise.catch(() => undefined);

    await jest.advanceTimersByTimeAsync(1000); // 1st backoff -> retry #1
    await jest.advanceTimersByTimeAsync(2000); // 2nd backoff -> retry #2

    await expect(promise).rejects.toThrow('timeout');
    expect(mockRequestUrl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('downloadFile (GET) retries once after a transient rejection and returns success', async () => {
    let calls = 0;
    mockRequestUrl.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('timeout'));
      return res(200);
    });

    const promise = client().downloadFile('Notes/a.md');
    promise.catch(() => undefined);

    await jest.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toBeInstanceOf(ArrayBuffer);
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });

  it('uploadFile (PUT) does NOT retry on a transient rejection — fails after exactly 1 call', async () => {
    mockRequestUrl.mockImplementation(() => Promise.reject(new Error('timeout')));

    await expect(client().uploadFile('Notes/a.md', new ArrayBuffer(2))).rejects.toThrow('timeout');
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  it('deleteFile (DELETE) does NOT retry on a transient rejection — fails after exactly 1 call', async () => {
    mockRequestUrl.mockImplementation(() => Promise.reject(new Error('timeout')));

    await expect(client().deleteFile('Notes/a.md', 'rid')).rejects.toThrow('timeout');
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  it('moveFile (MOVE) does NOT retry on a transient rejection — fails after exactly 1 call', async () => {
    // moveFile first calls ensureRemoteDir (MKCOL/PROPFIND helper) before the MOVE itself; make
    // every call reject so the very first request already fails without retrying.
    mockRequestUrl.mockImplementation(() => Promise.reject(new Error('timeout')));

    await expect(client().moveFile('a.md', 'b.md')).rejects.toThrow('timeout');
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  it('statFile (PROPFIND) does NOT retry on a resolved non-transient 404 status', async () => {
    mockRequestUrl.mockImplementation(() => res(404));

    await expect(client().statFile('Notes/missing.md')).resolves.toBeNull();
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  // Explicit scope boundary: getChanges()/getSyncToken() ride the REPORT method and are semantically
  // read-only, but 070's agreed scope is PROPFIND/GET only (REPORT is deliberately excluded — see the
  // describe-block comment). Both must fail immediately on a transient rejection, same as a write.
  it('getChanges (REPORT) does NOT retry on a transient rejection — fails after exactly 1 call', async () => {
    mockRequestUrl.mockImplementation(() => Promise.reject(new Error('timeout')));

    await expect(client().getChanges('sync-token-1')).rejects.toThrow('timeout');
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  // getSyncToken no longer performs any request (issue #37): Nextcloud's files DAV cannot answer a
  // sync-collection REPORT, so there is nothing here to retry or not retry. Covered by SCR-1.
  it('getSyncToken issues no request at all, so retry behaviour does not apply', async () => {
    mockRequestUrl.mockImplementation(() => Promise.reject(new Error('timeout')));

    await expect(client().getSyncToken()).resolves.toBeNull();
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });
});
