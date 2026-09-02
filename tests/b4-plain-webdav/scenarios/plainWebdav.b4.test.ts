// [SPEC:SD-3] The plugin's non-Nextcloud degradation, proven against a real WebDAV server.
//
// Every other live layer points at Nextcloud, so "what happens on a server that is not Nextcloud" was
// only ever asserted against mocks — i.e. against assumptions about how such a server replies. That is
// how the dispatch bug this feature fixes survived: the code that handles those servers was never the
// code that ran on them. This layer removes the assumption by using Apache httpd + mod_dav, which
// refuses `PROPFIND Depth: infinity` out of the box (see scripts/b4-plain-webdav.sh).
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

/**
 * Build a client the way production does — through the factory — inside its own remote collection.
 * The factory derives the remote base from the Vault name, so a unique name per test keeps runs (and
 * reruns against the same container) from colliding.
 */
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
      // INV-1. These flags are what the engine gates chunked upload, locking and version history on;
      // if any came back true the engine would reach for endpoints this server has never heard of.
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
      // Stage one of two, and the one that gives the next test its meaning: if this server ever began
      // accepting Depth: infinity, the listing below would pass for the wrong reason and the Depth: 1
      // recursion could rot unnoticed. Assert the precondition instead of trusting it.
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

      // Two levels below the Vault root: a single Depth: 1 request cannot see `deep/nested.md`, so a
      // complete listing is only possible if the client actually recurses.
      await client.createDirectory('');
      await client.uploadFile('top.md', bytes('top'));
      await client.createDirectory('deep');
      await client.uploadFile('deep/nested.md', bytes('nested'));

      // Paths come back Vault-relative. `deep/nested.md` appearing at all is the whole point: it sits
      // one level below what a single Depth: 1 PROPFIND can see, on a server that refuses
      // Depth: infinity outright — so it can only be here because the client recursed.
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

      // The second argument is the expected remote id; plain WebDAV has no file ids, so the client
      // deletes unconditionally — passing an empty string is the shape the interface asks for.
      await client.deleteFile('note.md', '');
      await expect(client.remoteExists('note.md')).resolves.toBe(false);
    });
  });

  describe('[SPEC:PWR-1] B4-6: the premise the remote-identity fix rests on', () => {
    // Feature 080's a-layer tests model a plain server as "never a checksum, always an ETag, and the
    // ETag moves when the body does". That model is the whole argument for re-reading the file after
    // an upload instead of recording the hash we sent. Asserting it here is what keeps the a-layer
    // tests from being a well-tested description of a server that does not exist.
    it('reports no checksum, and an ETag that changes when the body does', async () => {
      const { client } = await connectInOwnFolder(getEnv());
      await client.createDirectory('');

      await client.uploadFile('note.md', bytes('first body'));
      const first = await client.statFile('note.md');
      expect(first).not.toBeNull();

      // The null is not a server setting that could be turned on: StandardWebDAVClient has no way to
      // ask for a checksum, so classification always falls through to the ETag on this kind of server.
      expect(first!.checksum).toBeNull();
      expect(first!.etag).toBeTruthy();

      // Stable while nothing changes — otherwise every sync would see a change whatever we recorded.
      const again = await client.statFile('note.md');
      expect(again!.etag).toBe(first!.etag);

      // And it moves when the body does, which is what makes it usable as an identity at all.
      await client.uploadFile('note.md', bytes('second body, longer than the first'));
      const after = await client.statFile('note.md');
      expect(after!.etag).not.toBe(first!.etag);
      expect(after!.checksum).toBeNull();

      await client.deleteFile('note.md', '');
    });
  });
});
