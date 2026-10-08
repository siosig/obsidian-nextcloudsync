// [SPEC:SD-3] The plugin's non-Nextcloud degradation, proven against a real WebDAV server.
// Other live layers use Nextcloud, so servers that are not Nextcloud were only asserted against mocks. This layer
// uses Apache httpd + mod_dav, which refuses `PROPFIND Depth: infinity` out of the box (see scripts/b4-plain-webdav.sh).
import { requestUrl } from 'obsidian';
import { WebDAVFactory } from '../../../src/network/WebDAVFactory';
import { StandardWebDAVClient } from '../../../src/network/StandardWebDAVClient';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { IWebDAVClient } from '../../../src/network/IWebDAVClient';
import { DEFAULT_SETTINGS, DavSyncSettings, NextcloudFeatures } from '../../../src/types';
import { describePlainDav, basicAuth, uniqueRunFolder, PlainDavEnv } from '../support/env';

function settingsFor(env: PlainDavEnv): DavSyncSettings {
  return { ...DEFAULT_SETTINGS, serverUrl: env.serverUrl, username: env.username };
}

// Builds a client through the factory, as production does. The factory derives the remote base from the Vault name,
// so a unique name per test keeps runs (and reruns against the same container) from colliding.
async function connectInOwnFolder(
  env: PlainDavEnv,
): Promise<{ client: IWebDAVClient; features: NextcloudFeatures; vault: string }> {
  const vault = uniqueRunFolder();
  const app = { vault: { getName: () => vault } } as never;
  const { client, features } = await new WebDAVFactory(app, settingsFor(env), env.password).createClient();
  return { client, features, vault };
}

const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

describePlainDav('[SPEC:SD-3] b-4 — plugin against a real plain WebDAV server', (getEnv) => {
  describe('B4-1/B4-2: dispatch and feature reporting', () => {
    it('selects the standard WebDAV client and reports isNextcloud false', async () => {
      const { client, features } = await connectInOwnFolder(getEnv());

      expect(client).toBeInstanceOf(StandardWebDAVClient);
      expect(client).not.toBeInstanceOf(NextcloudClient);
      expect(features.isNextcloud).toBe(false);
    });

    it('B4-5: reports every Nextcloud-only capability as unavailable', async () => {
      // INV-1. The engine gates chunked upload, locking and version history on these flags; if any were true it
      // would reach for endpoints this server does not have.
      const { features } = await connectInOwnFolder(getEnv());

      expect(features).toMatchObject({
        isNextcloud: false,
        hasChecksums: false,
        hasFilesLocking: false,
        hasBulkUpload: false,
        syncToken: null,
      });
    });
  });

  describe('B4-3: listing works without Depth: infinity', () => {
    it('the server really does refuse Depth: infinity', async () => {
      // Precondition for the next test: if this server ever accepted Depth: infinity, the listing below would pass
      // for the wrong reason and the Depth: 1 recursion could rot unnoticed.
      const env = getEnv();
      const res = await requestUrl({
        url: env.serverUrl,
        method: 'PROPFIND',
        headers: { Authorization: basicAuth(env), Depth: 'infinity' },
        throw: false,
      });

      expect(res.status).not.toBe(207);
      expect(res.status).toBe(403);
    });

    it('lists a nested tree in full anyway', async () => {
      const { client } = await connectInOwnFolder(getEnv());

      // `deep/nested.md` is two levels below the Vault root, so a complete listing needs the client to recurse.
      await client.createDirectory('');
      await client.uploadFile('top.md', bytes('top'));
      await client.createDirectory('deep');
      await client.uploadFile('deep/nested.md', bytes('nested'));

      // Paths come back Vault-relative. `deep/nested.md` can only appear if the client recursed, since the server
      // refuses Depth: infinity.
      const files = (await client.getFiles('')).map((f) => f.path).sort();

      expect(files).toEqual(expect.arrayContaining(['deep/nested.md', 'top.md']));
    });
  });

  describe('B4-4: a full round-trip completes', () => {
    it('uploads, reads back, and deletes', async () => {
      const { client } = await connectInOwnFolder(getEnv());
      const body = 'plain webdav round trip';

      await client.createDirectory('');
      await client.uploadFile('note.md', bytes(body));

      const downloaded = await client.downloadFile('note.md');
      expect(new TextDecoder().decode(downloaded)).toBe(body);

      // Plain WebDAV has no file ids, so the client deletes unconditionally; the expected remote id is an empty string.
      await client.deleteFile('note.md', '');
      await expect(client.remoteExists('note.md')).resolves.toBe(false);
    });
  });

  describe('[SPEC:PWR-1] B4-6: the premise the remote-identity fix rests on', () => {
    // The a-layer tests model a plain server as "never a checksum, always an ETag, and the ETag moves when the body
    // does", which is why the file is re-read after an upload instead of recording the hash sent. Assert that here.
    it('reports no checksum, and an ETag that changes when the body does', async () => {
      const { client } = await connectInOwnFolder(getEnv());
      await client.createDirectory('');

      await client.uploadFile('note.md', bytes('first body'));
      const first = await client.statFile('note.md');
      expect(first).not.toBeNull();

      // StandardWebDAVClient cannot ask for a checksum, so classification falls through to the ETag on such servers.
      expect(first!.checksum).toBeNull();
      expect(first!.etag).toBeTruthy();

      // Stable while nothing changes, otherwise every sync would see a change.
      const again = await client.statFile('note.md');
      expect(again!.etag).toBe(first!.etag);

      // It moves when the body does, which makes it usable as an identity.
      await client.uploadFile('note.md', bytes('second body, longer than the first'));
      const after = await client.statFile('note.md');
      expect(after!.etag).not.toBe(first!.etag);
      expect(after!.checksum).toBeNull();

      await client.deleteFile('note.md', '');
    });
  });
});
