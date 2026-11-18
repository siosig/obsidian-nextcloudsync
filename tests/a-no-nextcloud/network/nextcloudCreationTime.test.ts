// NextcloudClient creation-time wire behaviour (docs/spec.md §9.7): nc:creation_time in listings, X-OC-CTime on PUT and on the
// assembling MOVE, the PROPPATCH completion after a chunked upload, and setCreationTime.
import { DOMParser } from '@xmldom/xmldom';
import { requestUrl } from 'obsidian';
import { NO_CACHE_HEADERS } from '../../../src/network/noCacheHeaders';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { DEFAULT_SETTINGS, DavSyncSettings, NetworkError } from '../../../src/types';
import { spec } from '../support/specRef';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

// Parsing a listing needs a DOMParser, which the a-layer node environment lacks.
(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;

const settings: DavSyncSettings = {
  ...DEFAULT_SETTINGS,
  serverUrl: 'https://nc/remote.php/dav/files/alice/',
  username: 'alice',
  deviceId: 'dev-1234',
};

type Over = Partial<{ text: string; headers: Record<string, string> }>;
function res(status: number, over: Over = {}) {
  return Promise.resolve({ status, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {}, ...over });
}

interface Call { url: string; method?: string; headers?: Record<string, string>; body?: unknown }
function calls(): Call[] {
  return mockRequestUrl.mock.calls.map((c) => c[0] as Call);
}
function callsOf(method: string): Call[] {
  return calls().filter((c) => c.method === method);
}

function makeClient(): NextcloudClient {
  return new NextcloudClient(settings, () => 'app-pw', 'Vault');
}

function listing(creation: string | null): string {
  const el = creation === null ? '' : `<nc:creation_time>${creation}</nc:creation_time>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/alice/Vault/a.md</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-1"</d:getetag>
        <d:getcontentlength>42</d:getcontentlength>
        <d:getlastmodified>Mon, 12 Jan 2026 10:00:00 GMT</d:getlastmodified>
        <d:resourcetype/>
        <oc:fileid>7</oc:fileid>
        ${el}
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
}

const EMPTY_MULTISTATUS = '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"></d:multistatus>';
const NC_NS = 'xmlns:nc="http://nextcloud.org/ns"';

const DATA = new TextEncoder().encode('hello').buffer as ArrayBuffer;
const CTIME_MS = 1700000000500;

beforeEach(() => mockRequestUrl.mockReset());

describe(`NextcloudClient listings request and read nc:creation_time ${spec('CT-6')}`, () => {
  it(`${spec('CT-6')} getFiles PROPFIND body requests nc:creation_time`, async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: EMPTY_MULTISTATUS }));
    await makeClient().getFiles('');
    const body = String(callsOf('PROPFIND')[0].body);
    expect(body).toContain(NC_NS);
    expect(body).toContain('<nc:creation_time/>');
  });

  it(`${spec('CT-6')} statFile PROPFIND body requests nc:creation_time`, async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: EMPTY_MULTISTATUS }));
    await makeClient().statFile('a.md');
    const body = String(callsOf('PROPFIND')[0].body);
    expect(body).toContain(NC_NS);
    expect(body).toContain('<nc:creation_time/>');
  });

  it(`${spec('CT-6')} getChanges REPORT body requests nc:creation_time`, async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: EMPTY_MULTISTATUS }));
    await makeClient().getChanges('tok');
    const body = String(callsOf('REPORT')[0].body);
    expect(body).toContain(NC_NS);
    expect(body).toContain('<nc:creation_time/>');
  });

  it(`${spec('CT-6')} getFiles maps nc:creation_time seconds to creationTime ms`, async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: listing('1700000000') }));
    const files = await makeClient().getFiles('');
    expect(files).toHaveLength(1);
    expect(files[0].creationTime).toBe(1700000000000);
  });

  it(`${spec('CT-6')} statFile maps nc:creation_time seconds to creationTime ms`, async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: listing('1700000000') }));
    const info = await makeClient().statFile('a.md');
    expect(info?.creationTime).toBe(1700000000000);
  });

  it(`${spec('CT-6')} getChanges maps nc:creation_time seconds to creationTime ms`, async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: listing('1700000000') }));
    const changes = await makeClient().getChanges('tok');
    expect(changes.modified).toHaveLength(1);
    expect(changes.modified[0].creationTime).toBe(1700000000000);
  });

  it(`${spec('CT-6')} getChanges without nc:creation_time yields creationTime 0`, async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: listing(null) }));
    const changes = await makeClient().getChanges('tok');
    expect(changes.modified[0].creationTime).toBe(0);
  });

  it.each([
    ['an absent element', null],
    ['an empty element', ''],
    ['a non-numeric value', 'abc'],
    ['zero', '0'],
    ['a negative value', '-5'],
  ])(`${spec('CT-6')} %s yields creationTime 0`, async (_label, value) => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: listing(value) }));
    const files = await makeClient().getFiles('');
    expect(files[0].creationTime).toBe(0);
  });
});

describe(`NextcloudClient.uploadFile X-OC-CTime ${spec('CT-4')}`, () => {
  it(`${spec('CT-4')} a valid ctime is sent as whole seconds, right after X-OC-MTime`, async () => {
    mockRequestUrl.mockReturnValueOnce(res(201));
    await makeClient().uploadFile('a.md', DATA, 1700000100000, { ctime: CTIME_MS });
    const h = callsOf('PUT')[0].headers ?? {};
    expect(h['X-OC-CTime']).toBe('1700000000');
    expect(h['X-OC-MTime']).toBe('1700000100');
  });

  it.each([
    ['an invalid ctime (one day)', 86400000],
    ['an undefined ctime', undefined],
  ])(`${spec('CT-4')} %s sends no X-OC-CTime`, async (_label, ctime) => {
    mockRequestUrl.mockReturnValueOnce(res(201));
    await makeClient().uploadFile('a.md', DATA, 1700000100000, { ctime });
    expect(callsOf('PUT')[0].headers).not.toHaveProperty('X-OC-CTime');
  });

  it(`${spec('CT-4')} no opts at all sends no X-OC-CTime`, async () => {
    mockRequestUrl.mockReturnValueOnce(res(201));
    await makeClient().uploadFile('a.md', DATA, 1700000100000);
    expect(callsOf('PUT')[0].headers).not.toHaveProperty('X-OC-CTime');
  });

  it.each([409, 404])(`${spec('CT-4')} the retry PUT after a %i carries the same X-OC-CTime`, async (status) => {
    mockRequestUrl
      .mockReturnValueOnce(res(status)) // first PUT: missing parent
      .mockReturnValue(res(201)); // MKCOL(s) and the retry PUT
    await makeClient().uploadFile('Deep/a.md', DATA, 1700000100000, { ctime: CTIME_MS });
    const puts = callsOf('PUT');
    expect(puts.length).toBe(2);
    expect(puts[0].headers?.['X-OC-CTime']).toBe('1700000000');
    expect(puts[1].headers?.['X-OC-CTime']).toBe('1700000000');
  });
});

describe(`NextcloudClient.uploadChunked MOVE headers and PROPPATCH completion ${spec('CT-5')}`, () => {
  const MTIME_MS = 1700000100000;

  // MKCOL session, chunk PUT(s), parent MKCOLs, MOVE (with the given response headers), then anything else (PROPPATCH, PROPFIND).
  function arrange(moveHeaders: Record<string, string>, proppatch: () => Promise<unknown> = () => res(207)) {
    mockRequestUrl.mockImplementation((p: Call) => {
      if (p.method === 'MOVE') return res(201, { headers: moveHeaders });
      if (p.method === 'PROPPATCH') return proppatch();
      return res(p.method === 'PROPFIND' ? 207 : 201);
    });
  }

  async function upload(opts: { mtime?: number; ctime?: number }): Promise<void> {
    await makeClient().uploadChunked('a.md', DATA, 1024, opts);
  }

  it(`${spec('CT-5')} the MOVE carries X-OC-MTime and X-OC-CTime in seconds`, async () => {
    arrange({ 'X-OC-MTime': 'accepted', 'X-OC-CTime': 'accepted' });
    await upload({ mtime: MTIME_MS, ctime: CTIME_MS });
    const h = callsOf('MOVE')[0].headers ?? {};
    expect(h['X-OC-MTime']).toBe('1700000100');
    expect(h['X-OC-CTime']).toBe('1700000000');
  });

  it(`${spec('CT-5')} without mtime the MOVE has no X-OC-MTime`, async () => {
    arrange({ 'X-OC-CTime': 'accepted' });
    await upload({ ctime: CTIME_MS });
    const h = callsOf('MOVE')[0].headers ?? {};
    expect(h).not.toHaveProperty('X-OC-MTime');
    expect(h['X-OC-CTime']).toBe('1700000000');
  });

  it(`${spec('CT-5')} an invalid ctime sends no X-OC-CTime on the MOVE`, async () => {
    arrange({ 'X-OC-MTime': 'accepted' });
    await upload({ mtime: MTIME_MS, ctime: 86400000 });
    expect(callsOf('MOVE')[0].headers).not.toHaveProperty('X-OC-CTime');
  });

  it(`${spec('CT-5')} both accepted: no PROPPATCH`, async () => {
    arrange({ 'X-OC-MTime': 'accepted', 'X-OC-CTime': 'accepted' });
    await upload({ mtime: MTIME_MS, ctime: CTIME_MS });
    expect(callsOf('PROPPATCH')).toHaveLength(0);
  });

  it(`${spec('CT-5')} response header names are matched case-insensitively`, async () => {
    arrange({ 'x-oc-mtime': 'accepted', 'x-oc-ctime': 'accepted' });
    await upload({ mtime: MTIME_MS, ctime: CTIME_MS });
    expect(callsOf('PROPPATCH')).toHaveLength(0);
  });

  it(`${spec('CT-5')} only the creation time not accepted: one PROPPATCH with nc:creation_time only`, async () => {
    arrange({ 'X-OC-MTime': 'accepted' });
    await upload({ mtime: MTIME_MS, ctime: CTIME_MS });
    const pp = callsOf('PROPPATCH');
    expect(pp).toHaveLength(1);
    const body = String(pp[0].body);
    expect(body).toContain('<nc:creation_time>1700000000</nc:creation_time>');
    expect(body).not.toContain('lastmodified');
  });

  it(`${spec('CT-5')} only the mtime not accepted: one PROPPATCH with {DAV:}lastmodified only`, async () => {
    arrange({ 'X-OC-CTime': 'accepted' });
    await upload({ mtime: MTIME_MS, ctime: CTIME_MS });
    const pp = callsOf('PROPPATCH');
    expect(pp).toHaveLength(1);
    const body = String(pp[0].body);
    expect(body).toContain('1700000100');
    expect(body).toMatch(/lastmodified/);
    expect(body).not.toContain('creation_time');
  });

  it(`${spec('CT-5')} neither accepted: one PROPPATCH with both properties`, async () => {
    arrange({});
    await upload({ mtime: MTIME_MS, ctime: CTIME_MS });
    const pp = callsOf('PROPPATCH');
    expect(pp).toHaveLength(1);
    const body = String(pp[0].body);
    expect(body).toContain('<nc:creation_time>1700000000</nc:creation_time>');
    expect(body).toMatch(/lastmodified/);
    expect(body).toContain('1700000100');
  });

  it(`${spec('CT-5')} a property that was not sent is not completed`, async () => {
    arrange({});
    await upload({ ctime: CTIME_MS }); // no mtime
    const body = String(callsOf('PROPPATCH')[0].body);
    expect(body).toContain('creation_time');
    expect(body).not.toMatch(/lastmodified/);
  });

  it(`${spec('CT-5')} nothing sent and nothing to complete: no PROPPATCH`, async () => {
    arrange({});
    await upload({});
    expect(callsOf('PROPPATCH')).toHaveLength(0);
  });

  it(`${spec('CT-5')} a throwing PROPPATCH does not fail the upload`, async () => {
    arrange({}, () => Promise.reject(new Error('network down')));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(upload({ mtime: MTIME_MS, ctime: CTIME_MS })).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it(`${spec('CT-5')} a non-207 PROPPATCH does not fail the upload`, async () => {
    arrange({}, () => res(403));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(upload({ mtime: MTIME_MS, ctime: CTIME_MS })).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it(`${spec('CT-5')} the checksum verification request comes after the PROPPATCH`, async () => {
    arrange({});
    await upload({ mtime: MTIME_MS, ctime: CTIME_MS });
    const methods = calls().map((c) => c.method);
    const moveAt = methods.indexOf('MOVE');
    const proppatchAt = methods.indexOf('PROPPATCH');
    const verifyAt = methods.indexOf('PROPFIND');
    expect(moveAt).toBeGreaterThanOrEqual(0);
    expect(proppatchAt).toBeGreaterThan(moveAt);
    expect(verifyAt).toBeGreaterThan(proppatchAt);
  });
});

describe(`NextcloudClient.setCreationTime ${spec('CT-6', 'CT-8')}`, () => {
  function multistatus(status: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/alice/Vault/a.md</d:href>
    <d:propstat><d:prop><nc:creation_time/></d:prop><d:status>${status}</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
  }

  it(`${spec('CT-6', 'CT-8')} sends exactly one PROPPATCH with the contract body and headers`, async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: multistatus('HTTP/1.1 200 OK') }));
    await makeClient().setCreationTime('a.md', 1700000000);
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    const c = calls()[0];
    expect(c.method).toBe('PROPPATCH');
    expect(c.url).toContain('/Vault/a.md');
    expect(c.headers).toMatchObject({ 'Content-Type': 'application/xml; charset=utf-8', ...NO_CACHE_HEADERS });
    expect(c.headers?.Authorization).toBeTruthy();
    const body = String(c.body);
    expect(body).toContain('<d:propertyupdate xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns">');
    expect(body).toContain('<nc:creation_time>1700000000</nc:creation_time>');
  });

  it(`${spec('CT-8')} 207 with a 200 propstat is applied`, async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: multistatus('HTTP/1.1 200 OK') }));
    await expect(makeClient().setCreationTime('a.md', 1700000000)).resolves.toBe('applied');
  });

  it(`${spec('CT-8')} 207 with a 403 propstat is rejected`, async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: multistatus('HTTP/1.1 403 Forbidden') }));
    await expect(makeClient().setCreationTime('a.md', 1700000000)).resolves.toBe('rejected');
  });

  it.each([400, 403, 405, 409, 415, 422, 501])(`${spec('CT-8')} HTTP %i is rejected`, async (status) => {
    mockRequestUrl.mockReturnValueOnce(res(status));
    await expect(makeClient().setCreationTime('a.md', 1700000000)).resolves.toBe('rejected');
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  it.each([401, 404, 423, 500])(`${spec('CT-8')} HTTP %i throws NetworkError (transient)`, async (status) => {
    mockRequestUrl.mockReturnValueOnce(res(status));
    const err = await makeClient().setCreationTime('a.md', 1700000000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).status).toBe(status);
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  it(`${spec('CT-8')} a transport exception is thrown and not retried`, async () => {
    mockRequestUrl.mockReturnValueOnce(Promise.reject(new Error('ECONNRESET')));
    await expect(makeClient().setCreationTime('a.md', 1700000000)).rejects.toThrow();
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  it(`${spec('CT-8')} an unreadable 207 body throws NetworkError(207)`, async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: '<html>not a multistatus</html>' }));
    const err = await makeClient().setCreationTime('a.md', 1700000000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).status).toBe(207);
  });
});
