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
// Nothing here yields to the event loop. The loop over responses stays with the caller precisely
// because that is where the anti-ANR yield lives (PARSE_YIELD_EVERY), and a timer has no business
// inside a reader.
const DAV_NS = 'DAV:';
const OC_NS = 'http://owncloud.org/ns';

/** Parse a multistatus body and return its `<D:response>` elements, in document order. */
export function parseResponses(xml: string): Element[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  return Array.from(doc.getElementsByTagNameNS(DAV_NS, 'response'));
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
