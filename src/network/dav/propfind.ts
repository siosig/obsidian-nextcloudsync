// Pure readers for PROPFIND / sync-collection response elements. They interpret nothing: keep/skip, scope and 404 routing stay with the caller.
// The property reads used to be duplicated across two clients, and abnormal responses are testable here from a plain string.
// parseResponses refuses a body that is not a DAV:multistatus instead of reading it as an empty listing (docs/spec.md §5.2).
// Nothing here yields: the response loop, with its anti-ANR yield (PARSE_YIELD_EVERY), stays with the caller.
import { RemoteListingUnreadableError } from '../../types';

const DAV_NS = 'DAV:';
const OC_NS = 'http://owncloud.org/ns';
const NC_NS = 'http://nextcloud.org/ns';

// Namespace of the element Blink/WebKit insert instead of throwing on malformed XML.
const PARSERERROR_NS = 'http://www.mozilla.org/newlayout/xml/parsererror.xml';
const PARSER_MESSAGE_MAX = 120;

// A 207 body that cannot be read as a listing; carries only the reason, the caller adds request context via readMultistatus.
export class MultistatusUnreadableError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'MultistatusUnreadableError';
  }
}

// Throws MultistatusUnreadableError when the body is not a listing at all (issue #51, docs/spec.md §5.2): returning no responses for a
// truncated body or an HTML error page would read as an empty vault and delete every tracked file. A genuine empty multistatus returns [].
export function parseResponses(rawXml: string): Element[] {
  // A BOM survives decoding as U+FEFF before the XML declaration (a proxy can add one).
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

// parseResponses with the request context attached to any failure, so the sync log names the call, path and body shape.
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

export function readSyncToken(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  return doc.getElementsByTagNameNS(DAV_NS, 'sync-token')[0]?.textContent ?? '';
}

export function readHref(resp: Element): string {
  return resp.getElementsByTagNameNS(DAV_NS, 'href')[0]?.textContent ?? '';
}

export function readProp(resp: Element): Element | null {
  return resp.getElementsByTagNameNS(DAV_NS, 'prop')[0] ?? null;
}

// Only sync-collection reads this (404 = deleted).
export function readStatusText(resp: Element): string | null {
  return resp.getElementsByTagNameNS(DAV_NS, 'status')[0]?.textContent ?? null;
}

export function readIsCollection(prop: Element): boolean {
  const resourcetype = prop.getElementsByTagNameNS(DAV_NS, 'resourcetype')[0];
  return (resourcetype?.getElementsByTagNameNS(DAV_NS, 'collection').length ?? 0) > 0;
}

// Lock owner from a lockdiscovery PROPFIND (issue #58), or null: D:owner (RFC 4918) first, then Nextcloud's nc:lock-owner (files_lock).
// Never throws, so it cannot interrupt the 423 being handled.
export function readLockDiscoveryOwner(xml: string): string | null {
  let responses: Element[];
  try {
    responses = parseResponses(xml);
  } catch {
    return null;
  }

  for (const resp of responses) {
    const prop = readProp(resp);
    if (!prop) continue;
    const activelock = prop.getElementsByTagNameNS(DAV_NS, 'lockdiscovery')[0]
      ?.getElementsByTagNameNS(DAV_NS, 'activelock')[0];
    if (!activelock) continue;

    const owner = activelock.getElementsByTagNameNS(DAV_NS, 'owner')[0]?.textContent?.trim();
    if (owner) return owner;

    const ncOwner = activelock.getElementsByTagNameNS(NC_NS, 'lock-owner')[0]?.textContent?.trim();
    if (ncOwner) return ncOwner;
  }
  return null;
}

export interface DavProps {
  etag: string | null;
  // 0 when absent or unparseable (also what an empty file reports).
  size: number;
  // Epoch ms; 0 when absent or unparseable.
  lastModified: number;
}

export function readDavProps(prop: Element): DavProps {
  const etag = prop.getElementsByTagNameNS(DAV_NS, 'getetag')[0]?.textContent?.replace(/"/g, '') ?? null;
  const size = parseInt(prop.getElementsByTagNameNS(DAV_NS, 'getcontentlength')[0]?.textContent ?? '0', 10);
  const lastModifiedStr = prop.getElementsByTagNameNS(DAV_NS, 'getlastmodified')[0]?.textContent ?? '';
  const lastModified = lastModifiedStr ? new Date(lastModifiedStr).getTime() : 0;
  return { etag, size, lastModified };
}

export interface OwncloudProps {
  checksum: string | null;
  fileId: string | null;
}

// Separate from readDavProps on purpose: a plain WebDAV caller just does not call it, and a boolean flag would reintroduce a branch.
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
