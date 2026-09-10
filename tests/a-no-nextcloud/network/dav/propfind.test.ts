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
// installed here rather than in the shared a-layer setup so nothing else changes behaviour — wrapped
// (feature 087) so a test can also ask for the Blink/WebKit shape of a parse failure, which is a
// <parsererror> document rather than a throw. See support/browserLikeDOMParser.ts for why that
// difference matters.
import {
  parseResponses, readSyncToken, readHref, readProp, readStatusText,
  readIsCollection, readDavProps, readOwncloudProps, MultistatusUnreadableError,
} from '../../../../src/network/dav/propfind';
import { installBrowserLikeDOMParser, PARSERERROR_NS } from '../../support/browserLikeDOMParser';

const dom = installBrowserLikeDOMParser();
afterAll(() => dom.restore());

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

  // Feature 087 (issue #51). Everything below this line is about ONE distinction: "the server said
  // there is nothing here" versus "we could not read what the server said". The old code collapsed
  // both into an empty list, and an empty list is what the full scan reads as "every tracked file was
  // deleted on the server". A multi-megabyte listing that arrived truncated became, in one step, a
  // request to delete the whole vault — held back only by the mass-delete breaker (large vaults) or
  // the per-file 404 re-check (small ones). This is the upstream fix: an unreadable body is an error.

  it('ULG-1 rejects an empty body — that is not a listing of nothing, it is no listing', () => {
    for (const body of ['', '\n  ', '   ']) {
      expect(() => parseResponses(body)).toThrow(MultistatusUnreadableError);
      expect(() => parseResponses(body)).toThrow(/empty body/);
    }
  });

  it('ULG-2 turns a throwing parser (xmldom) into the same typed error', () => {
    // @xmldom throws on malformed XML. The type has to be ours so callers can catch one thing.
    const truncated = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:respo';
    expect(() => parseResponses(truncated)).toThrow(MultistatusUnreadableError);
    expect(() => parseResponses(truncated)).toThrow(/^parser threw: /);
  });

  it('ULG-3 rejects a Blink-shaped parsererror document whether it is the root or a child', () => {
    // Obsidian's DOMParser never throws; it hands back a document with the error inside it. In the
    // "root" shape nothing else parsed. In the "nested" shape a REAL response survived next to the
    // error element — the shape that used to yield a partial listing, the worst possible output.
    const rootShape = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:respo';
    const nestedShape = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/a</d:href></d:response><d:resp';
    dom.simulateParserError(rootShape, 'root');
    dom.simulateParserError(nestedShape, 'nested');

    expect(() => parseResponses(rootShape)).toThrow(MultistatusUnreadableError);
    expect(() => parseResponses(rootShape)).toThrow(/^parser error: /);
    expect(() => parseResponses(nestedShape)).toThrow(MultistatusUnreadableError);
    expect(() => parseResponses(nestedShape)).toThrow(/^parser error: /);
  });

  it('ULG-3 keeps the parser message short enough for a single log line', () => {
    const input = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:respo';
    dom.simulateParserError(input, 'root');
    let reason = '';
    try { parseResponses(input); } catch (e) { reason = (e as MultistatusUnreadableError).reason; }
    expect(reason.length).toBeLessThanOrEqual('parser error: '.length + 120);
    expect(reason).not.toContain('\n');
  });

  it.each([
    ['an HTML error page', '<html><body>502 Bad Gateway</body></html>', /root is html, not DAV:multistatus/],
    ['an unrelated XML root', '<?xml version="1.0"?><foo/>', /root is foo, not DAV:multistatus/],
    ['a multistatus in the wrong namespace', '<multistatus xmlns="urn:not-dav"/>', /root is multistatus, not DAV:multistatus/],
  ])('ULG-4 rejects %s — well-formed is not the same as being an answer', (_label, body, reason) => {
    expect(() => parseResponses(body)).toThrow(MultistatusUnreadableError);
    expect(() => parseResponses(body)).toThrow(reason);
  });

  it('ULG-4 also rejects an XML declaration with no root element (not well-formed at all)', () => {
    // Distinct from the table above: this document has no root element, so it is malformed rather
    // than "well-formed but wrong root" — real parsers reject it the same way they reject a
    // truncated body (ULG-2/ULG-3), not via the root-name check.
    expect(() => parseResponses('<?xml version="1.0"?>')).toThrow(MultistatusUnreadableError);
  });

  it('ULG-5 still returns an empty list for a genuine multistatus with no responses', () => {
    // Feature 083 depends on this: a vault the server says is empty must read as empty, not as an
    // error, or absence-based deletion never converges on a small vault.
    expect(parseResponses(multistatus())).toEqual([]);
    expect(parseResponses('<d:multistatus xmlns:d="DAV:"/>')).toEqual([]);
  });

  describe('ULG-6 accepts every legitimate shape a real server sends', () => {
    it.each([
      ['a default namespace instead of a prefix', `<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/a</href><propstat><prop><getetag>"e"</getetag></prop></propstat></response></multistatus>`],
      ['an upper-case D: prefix', `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/a</D:href><D:propstat><D:prop><D:getetag>"e"</D:getetag></D:prop></D:propstat></D:response></D:multistatus>`],
      ['a UTF-8 BOM', `\uFEFF<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/a</d:href></d:response></d:multistatus>`],
      ['leading whitespace and no XML declaration', `\n\n  <d:multistatus xmlns:d="DAV:"><d:response><d:href>/a</d:href></d:response></d:multistatus>`],
      ['extra namespaces on the root', `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:response><d:href>/a</d:href></d:response></d:multistatus>`],
    ])('parses a listing with %s', (_label, body) => {
      expect(parseResponses(body).map(readHref)).toEqual(['/a']);
    });

    it('does not mistake a FILE called parsererror for a parse error', () => {
      // The check is for the parser's own element in its own namespace. A user's file name only ever
      // appears as text inside <d:href> / <d:displayname>, never as an element.
      const xml = multistatus(
        response('/remote.php/dav/files/alice/Vault/parsererror.md', `${FILE_PROPS}<d:displayname>parsererror</d:displayname>`),
        response('/remote.php/dav/files/alice/Vault/notes/parsererror/', FOLDER_PROPS),
      );
      expect(parseResponses(xml)).toHaveLength(2);
    });

    it('does not mistake a user element merely NAMED parsererror in another namespace', () => {
      // Belt and braces: even an element with that local name is only an error in the Mozilla
      // namespace (or as the document element). Anything else is server-defined property data.
      const xml = multistatus(response('/a', `${FILE_PROPS}<oc:parsererror>custom prop</oc:parsererror>`));
      expect(parseResponses(xml)).toHaveLength(1);
      expect(PARSERERROR_NS).not.toBe('http://owncloud.org/ns');
    });
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
    // xmldom throws here. In production readSyncToken is only reached after parseResponses has
    // already validated the same body (feature 087), so the Blink parsererror shape never gets this
    // far; the throw is pinned so a future reordering cannot make it silently return ''.
    expect(() => readSyncToken('not xml')).toThrow();
  });
});
