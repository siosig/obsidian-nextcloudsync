// Public link share: the plugin connects through a password-protected share (legacy and token URL forms) as Nextcloud.
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { WebDAVFactory } from '../../../src/network/WebDAVFactory';
import { describeLive } from '../support/env';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { ensureParentDirs, setupWorkspace } from '../support/workspace';
import { makeClient, makeSettings } from '../support/clientFactory';
import { buffersEqual, sha256Hex, textBuf, uniquePath } from '../support/helpers';
import { createPublicShare, deletePublicShare, publicShareEnv, PublicShare } from '../support/publicShare';

describeLive('public link share connects as Nextcloud', (getEnv) => {
  let s: { ws: IsolatedWorkspace; client: NextcloudClient } | undefined;
  let share: PublicShare | undefined;

  beforeAll(async () => {
    s = await setupWorkspace(getEnv());
    share = await createPublicShare(getEnv(), s.ws.remoteBase);
    // This server answers 404 to a PUT without parents, so the client's reactive MKCOL does not create them.
    await ensureParentDirs(getEnv(), s.ws, 'vault-legacy/_init.md');
    await ensureParentDirs(getEnv(), s.ws, 'vault-token/_init.md');
  });

  afterAll(async () => {
    if (share) await deletePublicShare(getEnv(), share);
    if (s) await cleanupWorkspace(s.client, s.ws);
  });

  describe.each(['legacy', 'token'] as const)('%s URL form', (form) => {
    const remoteBase = `vault-${form}`;
    const envFor = () => publicShareEnv(getEnv(), share as PublicShare, form);

    it('[SPEC:SD-7] is detected as Nextcloud with no account DAV and no locking', async () => {
      const shareEnv = envFor();
      const { client, features } = await new WebDAVFactory(
        { vault: { getName: () => remoteBase } } as never,
        makeSettings(shareEnv),
        () => shareEnv.appPassword,
      ).createClient();
      expect(client).toBeInstanceOf(NextcloudClient);
      expect(features).toMatchObject({
        isNextcloud: true,
        hasAccountDav: false,
        hasFilesLocking: false,
        hasChecksums: false,
        hasBulkUpload: false,
      });
      expect(features.version).not.toBe('');
    });

    it('[SPEC:SD-7] uploads, downloads, renames keeping the fileId, and deletes through the share', async () => {
      const c = makeClient(envFor(), remoteBase);
      await c.connect();

      await c.uploadFile('crud.md', textBuf('v1'));
      const back = await c.downloadFile('crud.md');
      expect(buffersEqual(back, textBuf('v1'))).toBe(true);

      const before = (await c.getFiles('')).find((f) => f.path === 'crud.md');
      expect(before?.fileId).not.toBeNull();
      expect(before?.fileId).toBeDefined();

      await c.moveFile('crud.md', 'crud-renamed.md');
      const afterMove = await c.getFiles('');
      expect(afterMove.find((f) => f.path === 'crud-renamed.md')?.fileId).toBe(before?.fileId);
      expect(afterMove.find((f) => f.path === 'crud.md')).toBeUndefined();

      await c.deleteFile('crud-renamed.md', '');
      const afterDelete = await c.getFiles('');
      expect(afterDelete.find((f) => f.path === 'crud-renamed.md')).toBeUndefined();
    });

    it('[SPEC:SD-10] a PUT through the share alone makes the server record the SHA-256', async () => {
      const c = makeClient(envFor(), remoteBase);
      await c.connect();
      const path = uniquePath('sd10');
      const data = textBuf(`sd10 ${form} ${Date.now()}`);

      await c.uploadFile(path, data);
      const entry = (await c.getFiles('')).find((f) => f.path === path);

      expect(entry?.checksum).toBe(await sha256Hex(data));
    });
  });
});
