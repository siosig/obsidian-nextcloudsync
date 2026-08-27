// Client-side PROPFIND parsing: the loop, the yield, and the routing (feature 075).
//
// No [SPEC:...] tags: the clauses live with the client-level and b-1 suites.
//
// The readers in src/network/dav answer what one response says. Everything the readers deliberately
// do NOT decide is asserted here, because those decisions differ per call site and are exactly what
// a careless "these three are nearly the same" merge would flatten:
//
//   - which side of the collection test each parser keeps
//   - which paths count as out of scope, and that differs between the two clients
//   - that a 404 status routes to a deletion instead of a modification
//
// And the yield. The parsers are async for one reason: a Depth:infinity listing of a large vault
// freezes the UI and trips an Android ANR unless the loop hands the event loop back periodically.
// Nothing about the extracted readers can preserve that — it lives in the loop — so it is pinned
// here, with a listing long enough to cross the threshold.
import { DOMParser } from '@xmldom/xmldom';
import { requestUrl } from 'obsidian';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { StandardWebDAVClient } from '../../../src/network/StandardWebDAVClient';
import { DEFAULT_SETTINGS, DavSyncSettings } from '../../../src/types';
import { PARSE_YIELD_EVERY } from '../../../src/util/limits';

(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;

const SERVER = 'https://nc.example.test/remote.php/dav/files/user';

function settings(over: Partial<DavSyncSettings> = {}): DavSyncSettings {
  return { ...DEFAULT_SETTINGS, serverUrl: SERVER, ...over };
}

function multistatus(...responses: string[]): string {
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${responses.join('')}</d:multistatus>`;
}

function fileResponse(href: string, over: { size?: number; fileId?: string; checksum?: string } = {}): string {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>
    <d:resourcetype/>
    <d:getetag>"e-${href}"</d:getetag>
    <d:getcontentlength>${over.size ?? 10}</d:getcontentlength>
    <d:getlastmodified>Wed, 27 Aug 2026 01:00:00 GMT</d:getlastmodified>
    ${over.checksum ? `<oc:checksums>SHA256:${over.checksum}</oc:checksums>` : ''}
    ${over.fileId ? `<oc:fileid>${over.fileId}</oc:fileid>` : ''}
  </d:prop></d:propstat></d:response>`;
}

function folderResponse(href: string, fileId = '1'): string {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>
    <d:resourcetype><d:collection/></d:resourcetype>
    <d:getetag>"folder"</d:getetag>
    <d:getlastmodified>Wed, 27 Aug 2026 01:00:00 GMT</d:getlastmodified>
    <oc:fileid>${fileId}</oc:fileid>
  </d:prop></d:propstat></d:response>`;
}

function deletedResponse(href: string): string {
  return `<d:response><d:href>${href}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;
}

/** Make every request return `xml` with a 207. */
function replyWith(xml: string): void {
  replyByUrl(() => xml);
}

/**
 * Reply per request URL. StandardWebDAVClient walks the tree with Depth:1 and recurses into every
 * folder it finds, so a mock that answers the same body for every URL would re-list the same
 * entries under each subfolder.
 */
function replyByUrl(pick: (url: string) => string): void {
  (requestUrl as unknown as jest.Mock).mockReset();
  (requestUrl as unknown as jest.Mock).mockImplementation((req: { url: string }) => Promise.resolve({
    status: 207, text: pick(req.url), json: {}, arrayBuffer: new ArrayBuffer(0), headers: {},
  }));
}

function nextcloud(remoteBase = ''): NextcloudClient {
  return new NextcloudClient(settings(), 'pw', remoteBase);
}

describe('NextcloudClient.getFiles — keeps files, drops folders', () => {
  it('returns files and ignores collections in the same listing', async () => {
    replyWith(multistatus(
      fileResponse('/remote.php/dav/files/user/a.md', { fileId: '1', checksum: 'AB' }),
      folderResponse('/remote.php/dav/files/user/sub'),
      fileResponse('/remote.php/dav/files/user/sub/b.md', { fileId: '2' }),
    ));
    const files = await nextcloud().getFiles('');
    expect(files.map((f) => f.path)).toEqual(['a.md', 'sub/b.md']);
  });

  it('carries the Nextcloud extension properties through', async () => {
    replyWith(multistatus(fileResponse('/remote.php/dav/files/user/a.md', { fileId: '77', checksum: 'CAFE' })));
    const [f] = await nextcloud().getFiles('');
    expect(f).toMatchObject({ fileId: '77', checksum: 'cafe', size: 10 });
  });

  it('skips the base folder itself and anything outside it', async () => {
    // "Outside the base" only exists when a vault folder is configured: with an empty remoteBase
    // every href maps to something, so the scope check has nothing to reject.
    replyWith(multistatus(
      folderResponse('/remote.php/dav/files/user/MyVault'),
      fileResponse('/remote.php/dav/files/user/OtherVault/secret.md'),
      fileResponse('/remote.php/dav/files/user/MyVault/keep.md'),
    ));
    expect((await nextcloud('MyVault').getFiles('')).map((f) => f.path)).toEqual(['keep.md']);
  });

  it('skips a response that carries no prop at all', async () => {
    replyWith(multistatus(
      '<d:response><d:href>/remote.php/dav/files/user/broken.md</d:href></d:response>',
      fileResponse('/remote.php/dav/files/user/ok.md'),
    ));
    expect((await nextcloud().getFiles('')).map((f) => f.path)).toEqual(['ok.md']);
  });
});

describe('NextcloudClient.getDirectories — the inverse of getFiles', () => {
  it('returns collections and ignores files', async () => {
    replyWith(multistatus(
      fileResponse('/remote.php/dav/files/user/a.md'),
      folderResponse('/remote.php/dav/files/user/sub', '9'),
    ));
    const dirs = await nextcloud().getDirectories('');
    expect(dirs.map((d) => d.path)).toEqual(['sub']);
    expect(dirs[0].fileId).toBe('9');
  });

  it('keeps exactly the entries getFiles drops, for the same body', async () => {
    // The two parsers are mirror images; flattening them into one would erase this.
    const body = multistatus(
      fileResponse('/remote.php/dav/files/user/a.md'),
      folderResponse('/remote.php/dav/files/user/sub'),
    );
    replyWith(body);
    const files = (await nextcloud().getFiles('')).map((f) => f.path);
    replyWith(body);
    const dirs = (await nextcloud().getDirectories('')).map((d) => d.path);
    expect(files).toEqual(['a.md']);
    expect(dirs).toEqual(['sub']);
    expect(files.filter((p) => dirs.includes(p))).toEqual([]); // disjoint
  });
});

describe('NextcloudClient.getChanges — routing a 404 to a deletion', () => {
  it('splits modified from deleted by the response status', async () => {
    replyWith(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
      ${fileResponse('/remote.php/dav/files/user/kept.md')}
      ${deletedResponse('/remote.php/dav/files/user/gone.md')}
      <d:sync-token>http://nc/ns/sync/99</d:sync-token>
    </d:multistatus>`);
    const changes = await nextcloud().getChanges('http://nc/ns/sync/1');
    expect(changes.modified.map((m) => m.path)).toEqual(['kept.md']);
    expect(changes.deleted).toEqual(['gone.md']);
    expect(changes.newSyncToken).toBe('http://nc/ns/sync/99');
  });

  it('reports a deletion even though the response has no prop to read', async () => {
    // The 404 branch is checked BEFORE the prop is required; reversing that loses every deletion.
    replyWith(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
      ${deletedResponse('/remote.php/dav/files/user/gone.md')}
    </d:multistatus>`);
    expect((await nextcloud().getChanges('t')).deleted).toEqual(['gone.md']);
  });

  it('drops an out-of-scope deletion before it becomes a path', async () => {
    // A server reporting a deletion outside the configured vault folder must not reach the delete
    // sink at all. The scope check runs before the 404 branch, which is what makes that true.
    replyWith(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
      ${deletedResponse('/remote.php/dav/files/user/OtherVault/secret.md')}
      ${deletedResponse('/remote.php/dav/files/user/MyVault/mine.md')}
    </d:multistatus>`);
    expect((await nextcloud('MyVault').getChanges('t')).deleted).toEqual(['mine.md']);
  });
});

describe('the anti-ANR yield survives the extraction', () => {
  it('hands the event loop back while parsing a listing longer than the threshold', async () => {
    // A Depth:infinity listing of a large vault is the case this exists for: without the yield the
    // UI freezes and Android raises an ANR. The readers cannot preserve it — it lives in the loop.
    const many = Array.from({ length: PARSE_YIELD_EVERY * 2 + 5 },
      (_, i) => fileResponse(`/remote.php/dav/files/user/f${i}.md`));
    replyWith(multistatus(...many));

    const setTimeoutSpy = jest.spyOn(window, 'setTimeout');
    try {
      const files = await nextcloud().getFiles('');
      expect(files).toHaveLength(many.length);
      // Two thresholds crossed in 205 entries ⇒ at least two yields.
      expect(setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 0).length).toBeGreaterThanOrEqual(2);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('does not yield for a listing that stays under the threshold', async () => {
    const few = Array.from({ length: 5 }, (_, i) => fileResponse(`/remote.php/dav/files/user/f${i}.md`));
    replyWith(multistatus(...few));
    const setTimeoutSpy = jest.spyOn(window, 'setTimeout');
    try {
      await nextcloud().getFiles('');
      expect(setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 0)).toEqual([]);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});

describe('StandardWebDAVClient.parseListing — a plain server has no oc: properties', () => {
  function standard(remoteBase = ''): StandardWebDAVClient {
    return new StandardWebDAVClient(settings(), 'pw', remoteBase);
  }

  it('separates files from folders, then walks into each folder', async () => {
    // Depth:1 recursion: the root listing names `sub`, and the client issues a second PROPFIND for
    // it. Answering both with the same body would double-count every entry.
    replyByUrl((url) => (url.includes('/sub')
      ? multistatus(
        folderResponse('/remote.php/dav/files/user/sub'),
        fileResponse('/remote.php/dav/files/user/sub/b.md'),
      )
      : multistatus(
        folderResponse('/remote.php/dav/files/user/'),
        fileResponse('/remote.php/dav/files/user/a.md'),
        folderResponse('/remote.php/dav/files/user/sub'),
      )));
    expect((await standard().getFiles('')).map((f) => f.path).sort()).toEqual(['a.md', 'sub/b.md']);
  });

  it('reports null for checksum and fileId rather than inventing them', async () => {
    // The oc: reader is never called on this path; the nulls are filled in by the caller.
    replyWith(multistatus(
      folderResponse('/remote.php/dav/files/user/'),
      fileResponse('/remote.php/dav/files/user/a.md', { fileId: '5', checksum: 'AB' }),
    )); // no subfolder ⇒ no recursion
    const [f] = await standard().getFiles('');
    expect(f.checksum).toBeNull();
    expect(f.fileId).toBeNull();
    expect(f.etag).not.toBeNull(); // the standard properties ARE read
  });
});
