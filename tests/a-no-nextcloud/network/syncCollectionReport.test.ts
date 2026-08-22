// [SPEC:SCR-1] Issue #37: the plugin must not issue the RFC 6578 sync-collection REPORT against
// Nextcloud's files DAV. That endpoint does not implement it — Sabre answers ReportNotSupported,
// which is HTTP 415 — so the request can only fail, and Nextcloud logs the rejection at ERROR level
// with a stack trace. An administrator therefore got a server-log error every time the plugin built
// a client, for a request whose failure was a foregone conclusion. "No token" is already the engine's
// normal path on Nextcloud (full scan, narrowed by the root-ETag short-circuit), so nothing is lost.
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

const res = (status: number, body: Partial<{ text: string; json: unknown }> = {}) =>
  Promise.resolve({ status, text: body.text ?? '', json: body.json ?? {}, arrayBuffer: new ArrayBuffer(0), headers: {} });

const client = () => new NextcloudClient(settings, 'pw', 'Vault');

describe('[SPEC:SCR-1] the sync-collection REPORT is never sent', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  it('getSyncToken() resolves to null without issuing any request', async () => {
    await expect(client().getSyncToken()).resolves.toBeNull();
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('connect() probes status.php and capabilities only — no REPORT', async () => {
    mockRequestUrl
      .mockReturnValueOnce(res(200, { json: { maintenance: false } })) // GET /status.php
      .mockReturnValueOnce(res(200, { json: {} }));                    // GET capabilities
    const features = await client().connect();

    const methods = mockRequestUrl.mock.calls.map((c: [{ method?: string }]) => c[0].method ?? 'GET');
    expect(methods).not.toContain('REPORT');
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
    expect(features.syncToken).toBeNull();
  });

  it('stays silent across repeated calls (no first-call probe that then latches)', async () => {
    const c = client();
    await c.getSyncToken();
    await c.getSyncToken();
    await c.getSyncToken();
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });
});
