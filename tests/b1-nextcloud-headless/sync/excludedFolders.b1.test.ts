// Layer B — user-managed excluded folders (EX), full SyncEngine end-to-end against a live
// Nextcloud (localhost Docker). Excluded folders must never be uploaded, never be downloaded,
// and — when added AFTER a folder is already synced — must NOT trigger a deletion (exclusion
// means "ignore", not "delete"; missing-path deletion candidates filter out isSystemExcluded).
// Boundary matching is folder-prefix, so `Attachments` excludes `Attachments/**` but not the
// sibling `Attachments-old`. The pure path logic is unit-tested in
// tests/a-no-nextcloud/util/excludedFolders.test.ts; here we prove the live sync wiring.
import { describeLive } from '../support/env';
import { setupWorkspace, ensureParentDirs } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice } from '../support/engineDevice';
import { textBuf } from '../support/helpers';

describeLive('Layer B — excluded folders end-to-end (engine)', (getEnv) => {
  let ws: IsolatedWorkspace;
  let baseClient: NextcloudClient;

  beforeAll(async () => {
    const s = await setupWorkspace(getEnv());
    ws = s.ws;
    baseClient = s.client;
  });

  afterAll(async () => {
    if (baseClient && ws) await cleanupWorkspace(baseClient, ws);
  });

  const remotePaths = async (): Promise<string[]> => (await baseClient.getFiles('')).map((f) => f.path);

  it('EX-1 upload: a file under an excluded folder is never pushed to the remote', async () => {
    const env = getEnv();
    const a = makeDevice(env, ws.remoteBase, 'A-ex1', { excludedFolders: ['Secret1'] });
    a.vault.seedLocal('keep1.md', 'survivor');
    a.vault.seedLocal('Secret1/x.md', 'top secret');
    await a.sync();

    const paths = await remotePaths();
    expect(paths.some((p) => p.endsWith('keep1.md'))).toBe(true);       // normal file synced
    expect(paths.some((p) => p.endsWith('Secret1/x.md'))).toBe(false);  // excluded file not pushed
    expect(await baseClient.remoteExists('Secret1')).toBe(false);       // folder not even created
  });

  it('EX-2 download: an excluded folder already on the remote is never pulled to the device', async () => {
    const env = getEnv();
    // Seed the remote directly (as if another client created it), then sync a device that excludes it.
    await ensureParentDirs(env, ws, 'Forbidden2/y.md');
    await baseClient.uploadFile('Forbidden2/y.md', textBuf('remote-only'));
    await ensureParentDirs(env, ws, 'shared2/note.md');
    await baseClient.uploadFile('shared2/note.md', textBuf('shared'));

    const b = makeDevice(env, ws.remoteBase, 'B-ex2', { excludedFolders: ['Forbidden2'] });
    await b.sync();

    expect(b.vault.localExists('shared2/note.md')).toBe(true);   // normal remote file pulled
    expect(b.vault.localExists('Forbidden2/y.md')).toBe(false);  // excluded remote file not pulled
    expect(b.vault.folderExists('Forbidden2')).toBe(false);
  });

  it('EX-3 excluding a folder AFTER it is synced does not delete it (exclusion = ignore, not delete)', async () => {
    const env = getEnv();
    const a = makeDevice(env, ws.remoteBase, 'A-ex3');
    a.vault.seedLocal('keep3.md', 'survivor');
    a.vault.seedLocal('Logs3/a.md', 'log line');
    await a.sync();
    expect((await remotePaths()).some((p) => p.endsWith('Logs3/a.md'))).toBe(true); // synced first

    // The user now adds Logs3 to the excluded list (live settings reference), then syncs again.
    a.settings.excludedFolders = ['Logs3'];
    await a.sync();

    // The already-synced files stay put on BOTH sides — no deletion is propagated.
    expect((await remotePaths()).some((p) => p.endsWith('Logs3/a.md'))).toBe(true);
    expect(a.vault.localExists('Logs3/a.md')).toBe(true);
  });

  it('EX-4 boundary: an excluded prefix never captures a sibling whose name merely starts with it', async () => {
    const env = getEnv();
    const a = makeDevice(env, ws.remoteBase, 'A-ex4', { excludedFolders: ['Attachments4'] });
    a.vault.seedLocal('keep4.md', 'survivor');
    a.vault.seedLocal('Attachments4/big.bin', 'excluded');
    a.vault.seedLocal('Attachments4-old/note.md', 'NOT excluded — sibling, not a child');
    await a.sync();

    const paths = await remotePaths();
    expect(paths.some((p) => p.endsWith('Attachments4-old/note.md'))).toBe(true); // sibling synced
    expect(paths.some((p) => p.endsWith('Attachments4/big.bin'))).toBe(false);    // excluded child not
  });

  it('EX-5 nested entry: a multi-segment excluded path excludes only its own subtree', async () => {
    const env = getEnv();
    const a = makeDevice(env, ws.remoteBase, 'A-ex5', { excludedFolders: ['a5/b'] });
    a.vault.seedLocal('a5/c.md', 'kept (a5/c is not under a5/b)');
    a.vault.seedLocal('a5/b/deep.md', 'excluded');
    await a.sync();

    const paths = await remotePaths();
    expect(paths.some((p) => p.endsWith('a5/c.md'))).toBe(true);
    expect(paths.some((p) => p.endsWith('a5/b/deep.md'))).toBe(false);
  });
});
