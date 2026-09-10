// PROPFIND / sync-collection response readers (feature 075).
//
// Pure functions that read one WebDAV response element and answer what it says. They do not decide
// anything: whether a collection is kept or skipped, which paths are out of scope, and how a 404
// status is routed all stay with the caller, because those answers differ per call site while the
// reading does not.
//
// The split exists for two reasons.
//
// The same property reads — getetag, getcontentlength, getlastmodified, and Nextcloud's checksum and
// fileid — were written out four times across two clients. Fixing one copy and missing another was a
// live possibility.
//
// And an abnormal response (a missing prop, a truncated document, a checksum in an unexpected shape)
// could until now only be exercised against a real Nextcloud, which meant standing up a server for
// every case. These take a string, so the same cases fit in a table.
//
// One of them does decide something, and it is the exception that proves the rule: parseResponses
// refuses a body that is not a DAV:multistatus (feature 087). That is not interpretation — it is
// the difference between reading an answer and pretending an unreadable one said "nothing here".
//
// Nothing here yields to the event loop. The loop over responses stays with the caller precisely
// because that is where the anti-ANR yield lives (PARSE_YIELD_EVERY), and a timer has no business
// inside a reader.
import { RemoteListingUnreadableError } from '../../types';

const DAV_NS = 'DAV:';
const OC_NS = 'http://owncloud.org/ns';

/**
 * The namespace browsers put on the element they insert in place of a parse failure. Blink and
 * WebKit — every runtime Obsidian ships on — do not throw on malformed XML; they return a document
 * with this element in it, and the rest of the tree is whatever happened to parse before the break.
 */
const PARSERERROR_NS = 'http://www.mozilla.org/newlayout/xml/parsererror.xml';
/** How much of a parser's own error text is worth carrying into a one-line diagnostic. */
const PARSER_MESSAGE_MAX = 120;

/**
 * A 207 body that cannot be read as a listing (feature 087). Carries only the reason: this module
 * does not know which request produced the body, so the caller adds that context via
 * {@link readMultistatus}.
 */
export class MultistatusUnreadableError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'MultistatusUnreadableError';
  }
}

/**
 * Parse a multistatus body and return its `<D:response>` elements, in document order.
 *
 * Throws {@link MultistatusUnreadableError} when the body is not a listing at all. That is the
 * whole point of feature 087 (issue #51): the old version returned whatever `DAV:response`
 * elements it could find, which for a truncated body, an HTML error page, or an empty body is
 * none — indistinguishable from a vault the server says is empty, which the full scan then reads
 * as "every tracked file was deleted remotely". An empty list is still returned for a genuine
 * multistatus with no responses; only the four ways of NOT being a multistatus are rejected.
 */
export function parseResponses(rawXml: string): Element[] {
  // A leading byte-order mark survives byte-to-string decoding as a literal U+FEFF character, which
  // sits before the XML declaration and makes it not the first thing in the document — a real proxy
  // or reverse-proxy layer can produce this on an otherwise perfectly good response.
  const xml = rawXml.charCodeAt(0) === 0xFEFF ? rawXml.slice(1) : rawXml;
  if (xml.trim() === '') throw new MultistatusUnreadableError('empty body');

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml');
  } catch (err) {
    // @xmldom (the test layers) throws where a browser inserts <parsererror>. Same fact, one type.
    throw new MultistatusUnreadableError(`parser threw: ${oneLine((err as Error).message)}`);
  }

  // The parser's own error element, in its own namespace, or standing in for the document element.
  // Looking for the ELEMENT (never for the string) is what keeps a user's file called
  // "parsererror.md" from reading as a broken listing: file names only ever appear as text.
  const parserError = doc.getElementsByTagNameNS(PARSERERROR_NS, 'parsererror')[0]
    ?? (doc.documentElement?.localName === 'parsererror' ? doc.documentElement : undefined);
  if (parserError) {
    throw new MultistatusUnreadableError(`parser error: ${oneLine(parserError.textContent ?? '')}`);
  }

  const root = doc.documentElement;
  if (!root || root.namespaceURI !== DAV_NS || root.localName !== 'multistatus') {
    throw new MultistatusUnreadableError(`root is ${root?.localName ?? '(none)'}, not DAV:multistatus`);
  }

  return Array.from(doc.getElementsByTagNameNS(DAV_NS, 'response'));
}

/**
 * {@link parseResponses} with the request context attached to any failure, so the error that
 * surfaces in the sync log and the Sync status dialog says which call, on which path, could not
 * be read — and how the body looked.
 */
export function readMultistatus(
  xml: string,
  ctx: { op: string; path: string; status: number; method: 'PROPFIND' | 'REPORT' },
): Element[] {
  try {
    return parseResponses(xml);
  } catch (err) {
    if (err instanceof MultistatusUnreadableError) throw new RemoteListingUnreadableError(ctx, xml, err.reason);
    throw err;
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, PARSER_MESSAGE_MAX);
}

/** The `<D:sync-token>` of a sync-collection report, or '' when the body carries none. */
export function readSyncToken(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  return doc.getElementsByTagNameNS(DAV_NS, 'sync-token')[0]?.textContent ?? '';
}

/** The response's `<D:href>`, or '' when absent. */
export function readHref(resp: Element): string {
  return resp.getElementsByTagNameNS(DAV_NS, 'href')[0]?.textContent ?? '';
}

/** The response's `<D:prop>`, or null when the response carries none (callers skip those). */
export function readProp(resp: Element): Element | null {
  return resp.getElementsByTagNameNS(DAV_NS, 'prop')[0] ?? null;
}

/** The response's `<D:status>` text, or null. Only sync-collection reads this (404 = deleted). */
export function readStatusText(resp: Element): string | null {
  return resp.getElementsByTagNameNS(DAV_NS, 'status')[0]?.textContent ?? null;
}

/** True when `<D:resourcetype>` names a `<D:collection>` — i.e. the entry is a folder. */
export function readIsCollection(prop: Element): boolean {
  const resourcetype = prop.getElementsByTagNameNS(DAV_NS, 'resourcetype')[0];
  return (resourcetype?.getElementsByTagNameNS(DAV_NS, 'collection').length ?? 0) > 0;
}

/** The RFC 4918 properties every WebDAV server answers with. */
export interface DavProps {
  /** ETag with its quotes stripped, or null when absent. */
  etag: string | null;
  /** Content length; 0 when absent or unparseable, which is also what a real empty file reports. */
  size: number;
  /** Last-modified as epoch milliseconds; 0 when absent or unparseable. */
  lastModified: number;
}

/**
 * Read the standard DAV properties.
 *
 * This is the single place those three reads exist. They used to be written out in
 * parsePropfindResponse, parsePropfindDirectories, parseSyncChanges and parseListing — the same
 * lines, four times, in two different clients.
 */
export function readDavProps(prop: Element): DavProps {
  const etag = prop.getElementsByTagNameNS(DAV_NS, 'getetag')[0]?.textContent?.replace(/"/g, '') ?? null;
  const size = parseInt(prop.getElementsByTagNameNS(DAV_NS, 'getcontentlength')[0]?.textContent ?? '0', 10);
  const lastModifiedStr = prop.getElementsByTagNameNS(DAV_NS, 'getlastmodified')[0]?.textContent ?? '';
  const lastModified = lastModifiedStr ? new Date(lastModifiedStr).getTime() : 0;
  return { etag, size, lastModified };
}

/** The Nextcloud/ownCloud extension properties. Absent on a plain WebDAV server. */
export interface OwncloudProps {
  /** Lowercased SHA-256 from `oc:checksums`, or null when the server offers none. */
  checksum: string | null;
  /** `oc:fileid` — the server-side identity used for rename detection and version history. */
  fileId: string | null;
}

/**
 * Read the `oc:` extension properties.
 *
 * Deliberately a separate function rather than a flag on {@link readDavProps}: a plain WebDAV caller
 * simply does not call it. A boolean parameter would put back a branch this feature exists to remove.
 */
export function readOwncloudProps(prop: Element): OwncloudProps {
  const checksumRaw = prop.getElementsByTagNameNS(OC_NS, 'checksums')[0]?.textContent ?? null;
  // The value is a space-separated list like "SHA256:abc123 MD5:def456"; anything but SHA-256 is
  // ignored rather than trusted, since that is the only algorithm the sync compares against.
  const m = checksumRaw ? checksumRaw.match(/SHA256:([0-9a-fA-F]+)/i) : null;
  return {
    checksum: m ? m[1].toLowerCase() : null,
    fileId: prop.getElementsByTagNameNS(OC_NS, 'fileid')[0]?.textContent ?? null,
  };
}
