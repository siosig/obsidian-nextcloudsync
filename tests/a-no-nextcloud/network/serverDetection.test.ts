// [SPEC:SD-1] Server-type detection and client dispatch (feature 073, from a maintainer report).
//
// The plugin promises in its README that a non-Nextcloud WebDAV server degrades gracefully: the
// Nextcloud-only features switch off and plain WebDAV sync takes over. It did not. The factory only
// fell back to StandardWebDAVClient when NextcloudClient.connect() *threw*, and connect() probes
// /status.php and the OCS capabilities endpoint with `throw: false` — so a plain server answering 404
// to both resolves normally, the Nextcloud client is kept, and `isNextcloud` comes back true because
// it was hardcoded. The fallback was therefore unreachable in every case that mattered.
//
// Detection is now taken from what the probes ANSWER rather than from whether an exception escaped:
//   isNextcloud = (capabilities 200 with ocs.data) OR (status.php 200 with productname ~ /nextcloud/i)
// Capabilities comes first because it is the source of every other feature flag — a connection that
// cannot read it has nothing to back an `isNextcloud: true` with. status.php is the second witness so
// a genuine Nextcloud whose OCS is closed off (401/403) is not misfiled as plain WebDAV.
//
// The case table below is the contract (specs/073-webdav-client-dispatch/contracts/server-detection.md).
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

/** A Nextcloud /status.php payload (the real endpoint returns productname alongside the version). */
const NEXTCLOUD_STATUS = { installed: true, maintenance: false, version: '34.0.1.1', productname: 'Nextcloud' };
/** ownCloud serves the same shape under a different product name. */
const OWNCLOUD_STATUS = { installed: true, maintenance: false, version: '10.15.0.5', productname: 'ownCloud' };
/** A minimal but valid OCS capabilities envelope. */
const OCS_CAPABILITIES = { ocs: { data: { version: { string: '34.0.1' }, capabilities: {} } } };

/**
 * Route probe responses by URL so a case reads as "what the server answers", not "what the Nth call
 * returns" — the call order is an implementation detail and should not be baked into the contract.
 */
function serveProbes(opts: {
  status?: () => ReturnType<typeof res>;
  capabilities?: () => ReturnType<typeof res>;
  dav?: () => ReturnType<typeof res>;
}): void {
  mockRequestUrl.mockImplementation((p: { url: string }) => {
    if (p.url.includes('status.php')) return (opts.status ?? (() => res(404)))();
    if (p.url.includes('ocs/v1.php')) return (opts.capabilities ?? (() => res(404)))();
    return (opts.dav ?? (() => res(207, { text: MULTISTATUS })))();
  });
}

const create = (serverUrl = 'https://cloud.example.com/remote.php/dav/files/alice/') =>
  new WebDAVFactory(app, settingsFor(serverUrl), 'pw').createClient();

describe('[SPEC:SD-1] server-type detection decides which client is used', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  it('D-1: a healthy Nextcloud keeps the Nextcloud client', async () => {
    serveProbes({ status: () => res(200, { json: NEXTCLOUD_STATUS }), capabilities: () => res(200, { json: OCS_CAPABILITIES }) });

    const { client, features } = await create();

    expect(client).toBeInstanceOf(NextcloudClient);
    expect(features.isNextcloud).toBe(true);
  });

  it('D-2: a Nextcloud whose OCS is closed off (401) is still Nextcloud', async () => {
    // status.php needs no authentication, so it remains a valid witness when OCS refuses the caller.
    // Without this second witness a locked-down but genuine Nextcloud would be demoted to plain WebDAV.
    serveProbes({ status: () => res(200, { json: NEXTCLOUD_STATUS }), capabilities: () => res(401) });

    const { client, features } = await create();

    expect(client).toBeInstanceOf(NextcloudClient);
    expect(features.isNextcloud).toBe(true);
  });

  it('D-3: a plain WebDAV server gets the standard client and isNextcloud false', async () => {
    // The reported bug: both probes 404, nothing throws, and the Nextcloud client was kept anyway.
    serveProbes({});

    const { client, features } = await create('https://dav.example.com/dav/');

    expect(client).toBeInstanceOf(StandardWebDAVClient);
    expect(features.isNextcloud).toBe(false);
  });

  it('D-4: a Nextcloud public link share lands on the standard client', async () => {
    // Same probe answers as D-3, and deliberately so: the share URL is not under /remote.php, so the
    // probes are built against /public.php/webdav and 404. Routing it to plain WebDAV therefore needs
    // no special case — it falls out of the general rule, which is what FR-009 asks for.
    serveProbes({});

    const { client, features } = await create('https://cloud.example.com/public.php/webdav/');

    expect(client).toBeInstanceOf(StandardWebDAVClient);
    expect(features.isNextcloud).toBe(false);
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
  });
});

describe('[SPEC:SD-2] detection costs a Nextcloud connection nothing extra', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  it('does not add probe round-trips on the Nextcloud path', async () => {
    // INV-4. Deciding in the factory instead would mean probing twice; reusing what connect() already
    // asked for keeps the common path at exactly the two probes it costs today.
    serveProbes({ status: () => res(200, { json: NEXTCLOUD_STATUS }), capabilities: () => res(200, { json: OCS_CAPABILITIES }) });

    await create();

    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });
});
