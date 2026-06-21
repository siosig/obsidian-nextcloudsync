// Layer B — empty-directory pruning (DP) and directory rename (DR) against a
// live Nextcloud (localhost Docker via .env NEXTCLOUD_*).
//
// Root bug: the engine is file-centric. Every delete sink issues a per-file
// DELETE only; a directory that becomes empty as a result is never removed, so
// empty directories linger forever on the remote AND on every client.
import { describeLive } from '../support/env';
import { setupWorkspace, ensureParentDirs } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { textBuf } from '../support/helpers';

describeLive('Layer B — empty-dir pruning (DP) & dir rename (DR)', (getEnv) => {
  let ws: IsolatedWorkspace;
  let client: NextcloudClient;

  beforeAll(async () => {
    const s = await setupWorkspace(getEnv());
    ws = s.ws;
    client = s.client;
  });

  afterAll(async () => {
    if (client && ws) await cleanupWorkspace(client, ws);
  });

  // ── Reproduction: characterize the CURRENT (buggy) behaviour ───────────────
  it('DP-repro: deleting every file in a folder leaves the empty directory on the remote', async () => {
    await ensureParentDirs(getEnv(), ws, 'reprodir/x.md');
    await client.uploadFile('reprodir/a.md', textBuf('a'));
    await client.uploadFile('reprodir/b.md', textBuf('b'));

    // Delete every file the way the engine does (per-file DELETE).
    await client.deleteFile('reprodir/a.md', '');
    await client.deleteFile('reprodir/b.md', '');

    // BUG: the now-empty directory still exists — only files were removed.
    expect(await client.remoteExists('reprodir')).toBe(true);

    // And the file-centric scan never surfaces the empty directory, so nothing
    // downstream can ever decide to prune it.
    const files = await client.getFiles('');
    expect(files.some((f) => f.path.startsWith('reprodir'))).toBe(false);
  });

  // ── Fix surface on NextcloudClient (RED until implemented) ─────────────────

  const stripSlash = (p: string): string => p.replace(/\/+$/, '');

  it('DP-dirs: getDirectories surfaces collections (folder = first-class listed entity)', async () => {
    await ensureParentDirs(getEnv(), ws, 'survey/x.md');
    const dirs = await client.getDirectories('');
    const names = dirs.map((d) => stripSlash(d.path));
    expect(names).toContain('survey');
  });

  it('DP-empty: isRemoteDirEmpty distinguishes a leaf-empty dir from a non-empty one', async () => {
    await ensureParentDirs(getEnv(), ws, 'leafempty/x.md'); // MKCOLs the dir, no file
    await ensureParentDirs(getEnv(), ws, 'hasfile/x.md');
    await client.uploadFile('hasfile/keep.md', textBuf('keep'));

    expect(await client.isRemoteDirEmpty('leafempty')).toBe(true);
    expect(await client.isRemoteDirEmpty('hasfile')).toBe(false);
  });

  it('DP-delete: deleteCollection removes an empty directory', async () => {
    await ensureParentDirs(getEnv(), ws, 'tossme/x.md');
    expect(await client.remoteExists('tossme')).toBe(true);

    await client.deleteCollection('tossme');

    expect(await client.remoteExists('tossme')).toBe(false);
  });

  it('DP-token: lockFile returns the files_lock token (server returns it in the XML body, not a header)', async () => {
    await ensureParentDirs(getEnv(), ws, 'lockdir/x.md');
    const token = await client.lockFile('lockdir');
    try {
      expect(typeof token).toBe('string');
      expect(token).toContain('files_lock/');
    } finally {
      await client.unlockFile('lockdir', token);
    }
  });
});
