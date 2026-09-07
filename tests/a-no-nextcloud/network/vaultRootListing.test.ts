// [SPEC:VRR-7] specs/083-empty-listing-absence-delete/contracts/vault-root.md (C-1 / C-2)
//
// The two IWebDAVClient implementations must agree on what "the vault folder is not there" means,
// because the engine branches on that answer alone and never on which client it holds.
//
// C-1 — why a root 404 can no longer be flattened into an empty listing: an empty listing is the
// server's truth about the folder's CONTENTS and legitimately drives absence-based deletion, while a
// 404 says nothing about any individual file. Collapsing the two made a missing vault folder look
// exactly like an emptied one, so the engine would happily trash the whole vault locally (issue #50).
// The distinction is drawn only at the ROOT: a 404 on a sub-path (NextcloudClient) or on a folder met
// while recursing (StandardWebDAVClient) still means "empty subtree" — that folder disappearing
// mid-scan is ordinary concurrency, not a broken sync target.
//
// C-2 — why createVaultRoot() reports 201 vs 405 instead of just "ok": a 404 from a listing cannot be
// trusted on its own (a broken listing looks identical), and re-seeding on a lie resets the tracking
// index for nothing. Only MKCOL has a side effect that succeeds exclusively when the folder really
// was absent, so 201 is the PROOF that licenses the re-seed and 405 is the proof the listing lied.
import { requestUrl } from 'obsidian';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { StandardWebDAVClient } from '../../../src/network/StandardWebDAVClient';
import { IWebDAVClient } from '../../../src/network/IWebDAVClient';
import { DEFAULT_SETTINGS, DavSyncSettings, NetworkError, RemoteRootMissingError } from '../../../src/types';
import { spec } from '../support/specRef';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

const res = (status: number, text = '') =>
  Promise.resolve({ status, text, json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });

const settings: DavSyncSettings = {
  ...DEFAULT_SETTINGS,
  serverUrl: 'https://nc/remote.php/dav/files/alice/',
  username: 'alice',
  deviceId: 'device-abcd1234',
};

/** Request URL prefix produced by the settings above (the Server URL minus its trailing slash). */
const URL_BASE = 'https://nc/remote.php/dav/files/alice';

/** Shape of the single argument every client hands to `requestUrl`; enough to assert method + URL. */
interface CapturedRequest {
  url: string;
  method?: string;
}

/** Requests issued with the given method, in call order (MKCOL ordering is part of the C-2 contract). */
function requestsOfMethod(method: string): CapturedRequest[] {
  const calls = mockRequestUrl.mock.calls as unknown as ReadonlyArray<readonly [CapturedRequest]>;
  return calls.map(([params]) => params).filter((params) => params.method === method);
}

// Depth:infinity listing of a vault folder that exists and holds nothing: the multistatus carries
// only the self entry, which both parsers drop. This is the case a root 404 must NOT be confused
// with — same `[]` result, opposite meaning.
const EMPTY_ROOT_MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/alice/Vault/</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-root"</d:getetag>
        <d:getlastmodified>Mon, 12 Jan 2026 10:00:00 GMT</d:getlastmodified>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

// Depth:1 listing StandardWebDAVClient gets for the vault root: itself, one file, one subfolder.
// The subfolder drives a second PROPFIND, which the test answers with 404 (it vanished mid-scan).
const STD_ROOT_DEPTH1_MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/remote.php/dav/files/alice/Vault/</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-root"</d:getetag>
        <d:getlastmodified>Mon, 12 Jan 2026 10:00:00 GMT</d:getlastmodified>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/alice/Vault/top.md</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-top"</d:getetag>
        <d:getcontentlength>7</d:getcontentlength>
        <d:getlastmodified>Mon, 12 Jan 2026 10:00:00 GMT</d:getlastmodified>
        <d:resourcetype/>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/alice/Vault/gone/</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-gone"</d:getetag>
        <d:getlastmodified>Mon, 12 Jan 2026 10:00:00 GMT</d:getlastmodified>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

const CLIENTS: ReadonlyArray<[string, (base: string) => IWebDAVClient]> = [
  ['NextcloudClient', (base) => new NextcloudClient(settings, 'pw', base)],
  ['StandardWebDAVClient', (base) => new StandardWebDAVClient(settings, 'pw', base)],
];

describe('vault root: listing (C-1) and creation (C-2)', () => {
  // Both clients parse PROPFIND XML with `new DOMParser()`, which the a-layer `node` env lacks (same
  // polyfill pattern as tests/a-no-nextcloud/network/statFile.test.ts).
  let prevDOMParser: unknown;
  beforeAll(() => {
    prevDOMParser = (globalThis as unknown as { DOMParser?: unknown }).DOMParser;
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- test-only polyfill
    (globalThis as unknown as { DOMParser: unknown }).DOMParser = require('@xmldom/xmldom').DOMParser;
  });
  afterAll(() => { (globalThis as unknown as { DOMParser: unknown }).DOMParser = prevDOMParser; });
  beforeEach(() => mockRequestUrl.mockReset());

  describe('C-1 getFiles', () => {
    it(`${spec('VRR-7')} NextcloudClient.getFiles('') throws RemoteRootMissingError on a root 404`, async () => {
      mockRequestUrl.mockImplementation(() => res(404));

      await expect(new NextcloudClient(settings, 'pw', 'Vault').getFiles('')).rejects.toThrow(RemoteRootMissingError);
    });

    it(`${spec('VRR-7')} the thrown root-404 error stays a NetworkError with status 404`, async () => {
      // Every existing `instanceof NetworkError` branch (retry queue, error reporting) must keep
      // classifying it exactly as before — the new type only ADDS a discriminator for the engine.
      mockRequestUrl.mockImplementation(() => res(404));

      const error: unknown = await new NextcloudClient(settings, 'pw', 'Vault').getFiles('').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RemoteRootMissingError);
      expect(error).toBeInstanceOf(NetworkError);
      expect((error as NetworkError).status).toBe(404);
    });

    it(`${spec('VRR-7')} NextcloudClient.getFiles('sub') still returns [] on a 404 (sub-paths are out of scope)`, async () => {
      mockRequestUrl.mockImplementation(() => res(404));

      await expect(new NextcloudClient(settings, 'pw', 'Vault').getFiles('sub')).resolves.toEqual([]);
    });

    it(`${spec('VRR-7')} NextcloudClient.getFiles('') returns [] on a 207 with no children (genuinely empty)`, async () => {
      // The distinction the whole feature rests on: "the folder is there and holds nothing" keeps
      // driving absence deletion, "the folder is not there" must not.
      mockRequestUrl.mockImplementation(() => res(207, EMPTY_ROOT_MULTISTATUS));

      await expect(new NextcloudClient(settings, 'pw', 'Vault').getFiles('')).resolves.toEqual([]);
    });

    it(`${spec('VRR-7')} StandardWebDAVClient.getFiles('') throws RemoteRootMissingError when the top-level PROPFIND is 404`, async () => {
      mockRequestUrl.mockImplementation(() => res(404));

      await expect(new StandardWebDAVClient(settings, 'pw', 'Vault').getFiles('')).rejects.toThrow(RemoteRootMissingError);
    });

    it(`${spec('VRR-7')} StandardWebDAVClient tolerates a 404 on a subfolder met while recursing and still lists the rest`, async () => {
      // Depth:1 recursion races against the server: a folder listed by the parent can be gone by the
      // time we descend into it. That is an empty subtree, not a missing sync root — throwing here
      // would turn a routine concurrent delete into a full-blown re-seed.
      mockRequestUrl.mockImplementation((params: CapturedRequest) =>
        params.url === `${URL_BASE}/Vault` ? res(207, STD_ROOT_DEPTH1_MULTISTATUS) : res(404));

      const files = await new StandardWebDAVClient(settings, 'pw', 'Vault').getFiles('');

      expect(files.map((f) => f.path)).toEqual(['top.md']);
    });
  });

  describe.each(CLIENTS)('C-2 %s.createVaultRoot', (_name, makeClient) => {
    it(`${spec('VRR-7')} returns 'created' when the MKCOL answers 201`, async () => {
      mockRequestUrl.mockImplementation(() => res(201));

      await expect(makeClient('Vault').createVaultRoot()).resolves.toBe('created');
      expect(requestsOfMethod('MKCOL').map((r) => r.url)).toEqual([`${URL_BASE}/Vault`]);
    });

    it(`${spec('VRR-7')} returns 'exists' when the MKCOL answers 405 (the listing lied)`, async () => {
      mockRequestUrl.mockImplementation(() => res(405));

      await expect(makeClient('Vault').createVaultRoot()).resolves.toBe('exists');
    });

    it(`${spec('VRR-7')} throws NetworkError(MKCOL) on any other status, so the caller never re-seeds on an unknown answer`, async () => {
      mockRequestUrl.mockImplementation(() => res(500, 'boom'));

      const error: unknown = await makeClient('Vault').createVaultRoot().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NetworkError);
      expect((error as NetworkError).status).toBe(500);
      expect((error as NetworkError).method).toBe('MKCOL');
    });

    it(`${spec('VRR-7')} propagates a transport rejection unchanged (MKCOL is a write: never retried, never swallowed)`, async () => {
      mockRequestUrl.mockImplementation(() => Promise.reject(new Error('timeout')));

      await expect(makeClient('Vault').createVaultRoot()).rejects.toThrow('timeout');
    });

    it(`${spec('VRR-7')} creates the parent segments first, then decides on the trailing vault folder`, async () => {
      // Parents are best-effort (same as the first upload's ensureRemoteDir) so that a nested
      // remoteBase can be created at all; only the LAST segment's status is evidence, because only
      // that one answers "was the vault folder itself missing?".
      mockRequestUrl.mockImplementation((params: CapturedRequest) =>
        params.url === `${URL_BASE}/a/b` ? res(201) : res(405));

      await expect(makeClient('a/b').createVaultRoot()).resolves.toBe('created');
      expect(requestsOfMethod('MKCOL').map((r) => r.url)).toEqual([`${URL_BASE}/a`, `${URL_BASE}/a/b`]);
    });

    it(`${spec('VRR-7')} issues no MKCOL at all and reports 'exists' when remoteBase is empty`, async () => {
      // With the vault directly under the Server URL there is nothing to create; reporting 'exists'
      // routes the caller to "the listing failed" — i.e. no destructive action — instead of letting
      // an unreachable configuration authorise a re-seed. WebDAVFactory always sets a vault name, so
      // this is defence in depth rather than a production path.
      mockRequestUrl.mockImplementation(() => res(201));

      await expect(makeClient('').createVaultRoot()).resolves.toBe('exists');
      expect(requestsOfMethod('MKCOL')).toEqual([]);
    });
  });
});
