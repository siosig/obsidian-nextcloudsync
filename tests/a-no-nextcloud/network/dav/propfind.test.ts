// Direct tests for the PROPFIND readers (feature 075).
//
// No [SPEC:...] tags: the clauses these serve are claimed by the client-level and b-1 suites.
//
// This file is the point of the extraction. Every case below used to require a running Nextcloud —
// a GCE instance, four minutes, and a real server willing to produce a malformed answer on demand,
// which is why abnormal responses were barely covered at all. They are strings now, so a new case
// costs one table row.
//
// DOMParser comes from @xmldom/xmldom, already a devDependency for the b-1 and b-4 layers. It is
// polyfilled here rather than in the shared a-layer setup so nothing else changes behaviour.
import { DOMParser } from '@xmldom/xmldom';
import {
  parseResponses, readSyncToken, readHref, readProp, readStatusText,
  readIsCollection, readDavProps, readOwncloudProps,
} from '../../../../src/network/dav/propfind';

(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;

/** Wrap response fragments in a multistatus envelope with both namespaces declared. */
function multistatus(...responses: string[]): string {
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${responses.join('')}</d:multistatus>`;
}

/** One response with the given href and prop body. */
function response(href: string, propBody: string, status?: string): string {
  return `<d:response><d:href>${href}</d:href>${status ? `<d:status>${status}</d:status>` : ''}<d:propstat><d:prop>${propBody}</d:prop></d:propstat></d:response>`;
}

const FILE_PROPS = `
  <d:resourcetype/>
  <d:getetag>"abc123"</d:getetag>
  <d:getcontentlength>1234</d:getcontentlength>
  <d:getlastmodified>Wed, 27 Aug 2026 01:00:00 GMT</d:getlastmodified>
  <oc:checksums>SHA256:DEADBEEF MD5:0123</oc:checksums>
  <oc:fileid>987</oc:fileid>`;

const FOLDER_PROPS = `
  <d:resourcetype><d:collection/></d:resourcetype>
  <d:getetag>"folder-etag"</d:getetag>
  <d:getlastmodified>Wed, 27 Aug 2026 01:00:00 GMT</d:getlastmodified>
  <oc:fileid>555</oc:fileid>`;

/** The single prop element of the first response in `xml`. */
function firstProp(xml: string): Element {
  const prop = readProp(parseResponses(xml)[0]);
  if (!prop) throw new Error('fixture has no prop');
  return prop;
}

describe('parseResponses', () => {
  it('returns the responses in document order', () => {
    const xml = multistatus(response('/a', FILE_PROPS), response('/b', FILE_PROPS));
    expect(parseResponses(xml).map(readHref)).toEqual(['/a', '/b']);
  });

  it('returns an empty list for a body with no responses', () => {
    expect(parseResponses(multistatus())).toEqual([]);
  });

  it('rejects a truncated document instead of returning half of it', () => {
    // NOTE — the two DOMParser implementations differ here, and the test pins the polyfill's:
    // @xmldom (used by this layer, b-1 and b-4) THROWS on malformed XML, while the browser
    // DOMParser Obsidian actually runs returns a document containing <parsererror>, which yields
    // zero DAV:response elements. The property that matters is the same either way — a truncated
    // body never produces partial entries — but a caller must be prepared for a throw in the test
    // layers and for an empty list in production.
    expect(() => parseResponses('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:respo')).toThrow();
  });

  it('returns an empty list for a body that is not XML at all', () => {
    // An HTML error page served with the wrong content type is a real failure mode.
    expect(parseResponses('<html><body>502 Bad Gateway</body></html>')).toEqual([]);
  });
});

describe('readHref / readProp / readStatusText', () => {
  it('reads the href', () => {
    expect(readHref(parseResponses(multistatus(response('/remote.php/dav/a.md', FILE_PROPS)))[0]))
      .toBe('/remote.php/dav/a.md');
  });

  it('returns an empty href rather than null when the element is missing', () => {
    const xml = multistatus('<d:response><d:propstat><d:prop/></d:propstat></d:response>');
    expect(readHref(parseResponses(xml)[0])).toBe('');
  });

  it('returns null for a response carrying no prop, which callers skip', () => {
    const xml = multistatus('<d:response><d:href>/a</d:href></d:response>');
    expect(readProp(parseResponses(xml)[0])).toBeNull();
  });

  it('reads a status when present and null when not', () => {
    const withStatus = multistatus(response('/gone.md', '', 'HTTP/1.1 404 Not Found'));
    expect(readStatusText(parseResponses(withStatus)[0])).toContain('404');
    const without = multistatus(response('/a.md', FILE_PROPS));
    expect(readStatusText(parseResponses(without)[0])).toBeNull();
  });
});

describe('readIsCollection', () => {
  it('is true for a resourcetype naming a collection', () => {
    expect(readIsCollection(firstProp(multistatus(response('/dir/', FOLDER_PROPS))))).toBe(true);
  });

  it('is false for an empty resourcetype', () => {
    expect(readIsCollection(firstProp(multistatus(response('/a.md', FILE_PROPS))))).toBe(false);
  });

  it('is false when resourcetype is absent entirely', () => {
    // Not every server sends one for files. Absence must read as "not a folder", not throw.
    const xml = multistatus(response('/a.md', '<d:getetag>"e"</d:getetag>'));
    expect(readIsCollection(firstProp(xml))).toBe(false);
  });

  it('is false when resourcetype names something other than a collection', () => {
    const xml = multistatus(response('/a', '<d:resourcetype><d:redirectref/></d:resourcetype>'));
    expect(readIsCollection(firstProp(xml))).toBe(false);
  });
});

describe('readDavProps — the standard properties', () => {
  it('reads all three from a complete response', () => {
    expect(readDavProps(firstProp(multistatus(response('/a.md', FILE_PROPS))))).toEqual({
      etag: 'abc123',
      size: 1234,
      lastModified: Date.parse('Wed, 27 Aug 2026 01:00:00 GMT'),
    });
  });

  it('strips every quote from the etag, not just the outer pair', () => {
    // Weak validators arrive as W/"abc"; the sync compares the bare value.
    const xml = multistatus(response('/a', '<d:getetag>W/"abc"</d:getetag>'));
    expect(readDavProps(firstProp(xml)).etag).toBe('W/abc');
  });

  it.each([
    ['getetag missing', '<d:getcontentlength>5</d:getcontentlength>', { etag: null, size: 5, lastModified: 0 }],
    ['getcontentlength missing', '<d:getetag>"e"</d:getetag>', { etag: 'e', size: 0, lastModified: 0 }],
    ['getlastmodified missing', '<d:getetag>"e"</d:getetag>', { etag: 'e', size: 0, lastModified: 0 }],
    ['everything missing', '<d:resourcetype/>', { etag: null, size: 0, lastModified: 0 }],
  ])('falls back to a usable value when %s', (_label, propBody, expected) => {
    expect(readDavProps(firstProp(multistatus(response('/a', propBody))))).toEqual(expected);
  });

  // The next two pin CURRENT behaviour, which is not the desirable behaviour. A non-numeric
  // content length or an unparseable date yields NaN, and NaN spreads: `NaN !== base.localSize` is
  // always true, so such a file reads as changed on every single sync. It is not data loss — the
  // comparisons fail safe — but it is a permanent rehash.
  //
  // They are asserted as-is rather than fixed here because this feature must not change behaviour
  // (FR-001). Pinning them means a future fix shows up as a failing test that has to be updated
  // deliberately, instead of a silent change nobody notices. No real server sends these, which is
  // why it has never surfaced.

  it('yields NaN for an unparseable content length (current behaviour, see note above)', () => {
    const xml = multistatus(response('/a', '<d:getcontentlength>not-a-number</d:getcontentlength>'));
    expect(readDavProps(firstProp(xml)).size).toBeNaN();
  });

  it('yields NaN for an unparseable date (current behaviour, see note above)', () => {
    const xml = multistatus(response('/a', '<d:getlastmodified>yesterday-ish</d:getlastmodified>'));
    expect(readDavProps(firstProp(xml)).lastModified).toBeNaN();
  });

  it('reads a genuinely empty file as size 0', () => {
    const xml = multistatus(response('/a', '<d:getcontentlength>0</d:getcontentlength>'));
    expect(readDavProps(firstProp(xml)).size).toBe(0);
  });

  it('reads a size beyond 32 bits', () => {
    const xml = multistatus(response('/a', '<d:getcontentlength>5368709120</d:getcontentlength>'));
    expect(readDavProps(firstProp(xml)).size).toBe(5368709120);
  });
});

describe('readOwncloudProps — the Nextcloud extensions', () => {
  it('extracts SHA-256 from a multi-algorithm checksum list, lowercased', () => {
    expect(readOwncloudProps(firstProp(multistatus(response('/a.md', FILE_PROPS))))).toEqual({
      checksum: 'deadbeef', fileId: '987',
    });
  });

  it.each([
    ['SHA256 alone', '<oc:checksums>SHA256:AABB</oc:checksums>', 'aabb'],
    ['SHA256 last in the list', '<oc:checksums>MD5:00 SHA1:11 SHA256:CCDD</oc:checksums>', 'ccdd'],
    ['lowercase algorithm name', '<oc:checksums>sha256:EEFF</oc:checksums>', 'eeff'],
  ])('reads the checksum when %s', (_label, propBody, expected) => {
    expect(readOwncloudProps(firstProp(multistatus(response('/a', propBody)))).checksum).toBe(expected);
  });

  it.each([
    ['no SHA-256 is offered', '<oc:checksums>MD5:0123 ADLER32:4567</oc:checksums>'],
    ['the element is empty', '<oc:checksums></oc:checksums>'],
    ['the element is absent', '<d:getetag>"e"</d:getetag>'],
  ])('reports no checksum when %s', (_label, propBody) => {
    // Falling back to conflict resolution is correct here; inventing a checksum would not be.
    expect(readOwncloudProps(firstProp(multistatus(response('/a', propBody)))).checksum).toBeNull();
  });

  it('reports no fileId when the server offers none', () => {
    const xml = multistatus(response('/a', '<d:getetag>"e"</d:getetag>'));
    expect(readOwncloudProps(firstProp(xml)).fileId).toBeNull();
  });

  it('reads nothing from a plain WebDAV response that has no oc: namespace at all', () => {
    const plain = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${response('/a.md', '<d:getetag>"e"</d:getetag>')}</d:multistatus>`;
    expect(readOwncloudProps(firstProp(plain))).toEqual({ checksum: null, fileId: null });
  });
});

describe('readSyncToken', () => {
  it('reads the token from a sync-collection report', () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:sync-token>http://nc/ns/sync/42</d:sync-token></d:multistatus>`;
    expect(readSyncToken(xml)).toBe('http://nc/ns/sync/42');
  });

  it('returns an empty string when the body carries none', () => {
    // A PROPFIND body has no sync-token; that must not read as an error.
    expect(readSyncToken(multistatus(response('/a', FILE_PROPS)))).toBe('');
  });

  it('rejects an unparseable body rather than reporting an empty token', () => {
    // Same DOMParser divergence as parseResponses — see the note there. An empty token would be
    // worse than a throw: it reads as "start from scratch" and triggers a full re-scan.
    expect(() => readSyncToken('not xml')).toThrow();
  });
});
