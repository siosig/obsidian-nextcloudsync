// [SPEC:SD-1] Server-type detection and client dispatch.
//
// A non-Nextcloud WebDAV server must degrade to plain WebDAV sync. connect() probes /status.php and the OCS
// capabilities endpoint with `throw: false`, so a plain server answering 404 to both resolves normally; detection must
// therefore come from what the probes ANSWER, not from whether an exception escaped:
//   isNextcloud = (capabilities 200 with ocs.data) OR (status.php 200 with a string versionstring)
// `productname` is not read: a server admin can rename it through theming, while `versionstring` survives the rename.
// Capabilities comes first because it backs every other feature flag; status.php is the second witness so a genuine
// Nextcloud whose OCS is closed off (401/403) is not misfiled as plain WebDAV.
import { requestUrl } from 'obsidian';
import { WebDAVFactory } from '../../../src/network/WebDAVFactory';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { StandardWebDAVClient } from '../../../src/network/StandardWebDAVClient';
import { DEFAULT_SETTINGS, DavSyncSettings, MaintenanceModeError } from '../../../src/types';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

const app = { vault: { getName: () => 'Vault' } } as never;
const MULTISTATUS = '<d:multistatus xmlns:d="DAV:"></d:multistatus>';

function settingsFor(serverUrl: string): DavSyncSettings {
  return { ...DEFAULT_SETTINGS, serverUrl, username: 'alice' };
}

function res(status: number, body: Partial<{ text: string; json: unknown }> = {}) {
  return Promise.resolve({
    status,
    text: body.text ?? '',
    json: body.json ?? {},
    arrayBuffer: new ArrayBuffer(0),
    headers: {},
  });
}

// A 200 whose body is not JSON: reading `json` throws, as Obsidian's getter does on such a body.
function resNonJson(status: number, text: string) {
  return Promise.resolve({
    status,
    text,
    get json(): unknown { throw new SyntaxError('Unexpected token < in JSON'); },
    arrayBuffer: new ArrayBuffer(0),
    headers: {},
  });
}

const NEXTCLOUD_STATUS = { installed: true, maintenance: false, version: '34.0.1.1', versionstring: '34.0.1', productname: 'Nextcloud' };
// ownCloud serves the same shape under a different product name.
const OWNCLOUD_STATUS = { installed: true, maintenance: false, version: '10.15.0.5', versionstring: '10.15.0', productname: 'ownCloud' };
const OCS_CAPABILITIES = { ocs: { data: { version: { string: '34.0.1' }, capabilities: {} } } };

// Route probe responses by URL so a case reads as "what the server answers", not "what the Nth call returns"; call
// order is an implementation detail.
function serveProbes(opts: {
  status?: () => Promise<unknown>;
  capabilities?: () => Promise<unknown>;
  dav?: () => ReturnType<typeof res>;
}): void {
  mockRequestUrl.mockImplementation((p: { url: string }) => {
    if (p.url.includes('status.php')) return (opts.status ?? (() => res(404)))();
    if (p.url.includes('ocs/v1.php')) return (opts.capabilities ?? (() => res(404)))();
    return (opts.dav ?? (() => res(207, { text: MULTISTATUS })))();
  });
}

const create = (serverUrl = 'https://cloud.example.com/remote.php/dav/files/alice/') =>
  new WebDAVFactory(app, settingsFor(serverUrl), () => 'pw').createClient();

describe('[SPEC:SD-1] server-type detection decides which client is used', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  it('D-1: a healthy Nextcloud keeps the Nextcloud client', async () => {
    serveProbes({ status: () => res(200, { json: NEXTCLOUD_STATUS }), capabilities: () => res(200, { json: OCS_CAPABILITIES }) });

    const { client, features } = await create();

    expect(client).toBeInstanceOf(NextcloudClient);
    expect(features.isNextcloud).toBe(true);
    expect(features.hasAccountDav).toBe(true);
  });

  it('D-2: a Nextcloud whose OCS is closed off (401) is still Nextcloud', async () => {
    // status.php needs no authentication, so it remains a valid witness when OCS refuses the caller.
    // Without this second witness a locked-down but genuine Nextcloud would be demoted to plain WebDAV.
    serveProbes({ status: () => res(200, { json: NEXTCLOUD_STATUS }), capabilities: () => res(401) });

    const { client, features } = await create();

    expect(client).toBeInstanceOf(NextcloudClient);
    expect(features.isNextcloud).toBe(true);
    expect(features.hasAccountDav).toBe(true);
  });

  it('D-3: a plain WebDAV server gets the standard client and isNextcloud false', async () => {
    // The reported bug: both probes 404, nothing throws, and the Nextcloud client was kept anyway.
    serveProbes({});

    const { client, features } = await create('https://dav.example.com/dav/');

    expect(client).toBeInstanceOf(StandardWebDAVClient);
    expect(features.isNextcloud).toBe(false);
    expect(features.hasAccountDav).toBe(false);
  });

  const PUBLIC_SHARE_ANSWERS = () => ({ status: () => res(200, { json: NEXTCLOUD_STATUS }), capabilities: () => res(401) });
  const probedUrls = () => mockRequestUrl.mock.calls.map((c) => c[0].url);

  it('D-4: a legacy public link share is detected as Nextcloud without account DAV', async () => {
    // Probes go to the install root (the Server URL cut at /public.php), where status.php answers; OCS is closed to the share
    // credentials (401), so status.php is the witness. A share has no account DAV tree, hence hasAccountDav false.
    serveProbes(PUBLIC_SHARE_ANSWERS());

    const { client, features } = await create('https://cloud.example.com/public.php/webdav/');

    expect(client).toBeInstanceOf(NextcloudClient);
    expect(features.isNextcloud).toBe(true);
    expect(features.hasAccountDav).toBe(false);
    expect(probedUrls()).toContain('https://cloud.example.com/status.php');
    expect(probedUrls().some((u) => u.includes('/ocs/'))).toBe(false);
  });

  it('D-8: a token-form public share URL is detected the same way', async () => {
    serveProbes(PUBLIC_SHARE_ANSWERS());

    const { client, features } = await create('https://cloud.example.com/public.php/dav/files/TOKEN/');

    expect(client).toBeInstanceOf(NextcloudClient);
    expect(features.isNextcloud).toBe(true);
    expect(features.hasAccountDav).toBe(false);
    expect(probedUrls()).toContain('https://cloud.example.com/status.php');
    expect(probedUrls().some((u) => u.includes('/ocs/'))).toBe(false);
  });

  it('D-9: a public share on a Nextcloud installed in a subfolder probes the subfolder root', async () => {
    serveProbes(PUBLIC_SHARE_ANSWERS());

    const { client, features } = await create('https://cloud.example.com/nextcloud/public.php/webdav/');

    expect(client).toBeInstanceOf(NextcloudClient);
    expect(features.isNextcloud).toBe(true);
    expect(features.hasAccountDav).toBe(false);
    expect(probedUrls()).toContain('https://cloud.example.com/nextcloud/status.php');
    expect(probedUrls().some((u) => u.includes('/ocs/'))).toBe(false);
  });

  it('D-10: a Nextcloud renamed through theming (productname changed) is still Nextcloud, with its version', async () => {
    serveProbes({
      status: () => res(200, { json: { installed: true, maintenance: false, version: '34.0.4.1', versionstring: '34.0.4', productname: 'MyCloud' } }),
      capabilities: () => res(401),
    });

    const { client, features } = await create();

    expect(client).toBeInstanceOf(NextcloudClient);
    expect(features.isNextcloud).toBe(true);
    expect(features.hasAccountDav).toBe(true);
    expect(features.version).toBe('34.0.4');
  });

  it('D-11: a plain server whose status.php is JSON without a versionstring is plain WebDAV', async () => {
    serveProbes({ status: () => res(200, { json: { status: 'ok' } }) });

    const { client, features } = await create('https://dav.example.com/dav/');

    expect(client).toBeInstanceOf(StandardWebDAVClient);
    expect(features.isNextcloud).toBe(false);
    expect(features.hasAccountDav).toBe(false);
  });

  it('D-12: a status.php answering 200 with a non-JSON body is "no evidence", never an exception', async () => {
    serveProbes({ status: () => resNonJson(200, '<!DOCTYPE html><html><body>not dav</body></html>') });

    const { client, features } = await create('https://dav.example.com/dav/');

    expect(client).toBeInstanceOf(StandardWebDAVClient);
    expect(features.isNextcloud).toBe(false);
    expect(features.hasAccountDav).toBe(false);

    await expect(new NextcloudClient(settingsFor('https://dav.example.com/dav/'), () => 'pw', 'Vault').connect()).resolves.toMatchObject({
      isNextcloud: false,
    });
  });

  it('D-14: ownCloud with OCS closed off is still detected by its versionstring', async () => {
    serveProbes({ status: () => res(200, { json: OWNCLOUD_STATUS }), capabilities: () => res(401) });

    const { client, features } = await create();

    expect(client).toBeInstanceOf(NextcloudClient);
    expect(features.isNextcloud).toBe(true);
    expect(features.hasAccountDav).toBe(true);
    expect(features.version).toBe('10.15.0');
  });

  it.each(['https://h/public.php/webdav/', 'https://h/public.php/dav/files/TOKEN/'])(
    'D-15: a public link share (%s) sends no capabilities request and enables no capability',
    async (url) => {
      serveProbes({
        status: () => res(200, { json: NEXTCLOUD_STATUS }),
        capabilities: () => Promise.reject(new Error('capabilities must not be requested for a public link share')),
      });

      const { client, features } = await create(url);

      expect(client).toBeInstanceOf(NextcloudClient);
      expect(features.isNextcloud).toBe(true);
      expect(features.hasAccountDav).toBe(false);
      expect(features.hasChecksums).toBe(false);
      expect(features.hasFilesLocking).toBe(false);
      expect(features.hasBulkUpload).toBe(false);
      expect(features.version).toBe('34.0.1');
      expect(probedUrls().some((u) => u.includes('/ocs/'))).toBe(false);
    },
  );

  it('D-13: maintenance mode on a public share URL still surfaces as MaintenanceModeError', async () => {
    serveProbes({ status: () => res(200, { json: { ...NEXTCLOUD_STATUS, maintenance: true } }) });

    await expect(create('https://cloud.example.com/public.php/webdav/')).rejects.toBeInstanceOf(MaintenanceModeError);
  });

  it('D-5: maintenance mode still surfaces as MaintenanceModeError, not as a demotion', async () => {
    // Maintenance is a Nextcloud-only state; answering it by silently switching to plain WebDAV would
    // hide a temporary server condition behind a permanent-looking capability loss.
    serveProbes({ status: () => res(200, { json: { ...NEXTCLOUD_STATUS, maintenance: true } }) });

    await expect(create()).rejects.toBeInstanceOf(MaintenanceModeError);
  });

  it('D-6: ownCloud stays on the Nextcloud client (deliberate, not an oversight)', async () => {
    // Its OCS answers, so the Nextcloud client's feature detection works. Demoting it would remove
    // working functionality from existing users on the strength of a product name we cannot test.
    serveProbes({ status: () => res(200, { json: OWNCLOUD_STATUS }), capabilities: () => res(200, { json: OCS_CAPABILITIES }) });

    const { client, features } = await create();

    expect(client).toBeInstanceOf(NextcloudClient);
    expect(features.isNextcloud).toBe(true);
    expect(features.hasAccountDav).toBe(true);
  });

  it('D-7: a probe failing at the network layer is not read as "not Nextcloud"', async () => {
    // Detection reads what the server ANSWERS. No answer is not an answer of "plain WebDAV" — it is a
    // transport problem, and the existing retry against the standard client stays as the safety net.
    mockRequestUrl.mockImplementation((p: { url: string }) => {
      if (p.url.includes('status.php') || p.url.includes('ocs/v1.php')) return Promise.reject(new Error('ETIMEDOUT'));
      return res(207, { text: MULTISTATUS });
    });

    const { client, features } = await create();

    expect(client).toBeInstanceOf(StandardWebDAVClient);
    expect(features.isNextcloud).toBe(false);
    expect(features.hasAccountDav).toBe(false);
  });
});

describe('[SPEC:SD-2] detection costs a Nextcloud connection nothing extra', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  it('does not add probe round-trips on the Nextcloud path', async () => {
    // Deciding in the factory instead would mean probing twice; reusing what connect() already asked for keeps the
    // common path at exactly the two probes.
    serveProbes({ status: () => res(200, { json: NEXTCLOUD_STATUS }), capabilities: () => res(200, { json: OCS_CAPABILITIES }) });

    await create();

    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });

  it('a public link share costs one probe: status.php only, no capabilities (docs/spec.md §3)', async () => {
    serveProbes({ status: () => res(200, { json: NEXTCLOUD_STATUS }), capabilities: () => res(401) });

    await create('https://cloud.example.com/public.php/webdav/');

    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  it('probe URLs for account and plain WebDAV Server URLs are unchanged', async () => {
    serveProbes({ status: () => res(200, { json: NEXTCLOUD_STATUS }), capabilities: () => res(200, { json: OCS_CAPABILITIES }) });
    await create('https://cloud.example.com/remote.php/dav/files/alice/');
    const accountUrls = mockRequestUrl.mock.calls.map((c) => c[0].url);
    expect(accountUrls).toContain('https://cloud.example.com/status.php');
    expect(accountUrls).toContain('https://cloud.example.com/ocs/v1.php/cloud/capabilities?format=json');

    mockRequestUrl.mockReset();
    serveProbes({});
    await create('https://dav.example.com/dav/');
    const plainUrls = mockRequestUrl.mock.calls.map((c) => c[0].url);
    // The double slash is the existing behaviour (the Server URL keeps its trailing slash); it must not change.
    expect(plainUrls).toContain('https://dav.example.com/dav//status.php');
    expect(plainUrls).toContain('https://dav.example.com/dav//ocs/v1.php/cloud/capabilities?format=json');
  });
});

describe('[SPEC:SD-5] the server version comes from capabilities, then from status.php versionstring', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  it('capabilities wins over status.php when both report a version', async () => {
    serveProbes({
      status: () => res(200, { json: { ...NEXTCLOUD_STATUS, versionstring: '33.0.0' } }),
      capabilities: () => res(200, { json: OCS_CAPABILITIES }),
    });

    const { features } = await create();

    expect(features.version).toBe('34.0.1');
  });

  it('falls back to the status.php versionstring when capabilities is closed off', async () => {
    serveProbes({
      status: () => res(200, { json: { installed: true, maintenance: false, version: '34.0.4.1', versionstring: '34.0.4', productname: 'MyCloud' } }),
      capabilities: () => res(401),
    });

    const { features } = await create();

    expect(features.version).toBe('34.0.4');
  });

  it('is empty when neither probe reports a version', async () => {
    serveProbes({ capabilities: () => res(200, { json: { ocs: { data: { capabilities: {} } } } }) });

    const { features } = await create();

    expect(features.isNextcloud).toBe(true);
    expect(features.version).toBe('');
  });
});
