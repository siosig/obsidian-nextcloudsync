// Layer B (MDF-B1): "Mirror from remote" when a local-only file cannot be deleted, against a live Nextcloud, driven
// through the real SyncEngine over an in-memory vault. Covers: the mirror reports each file it could not delete (not
// counted as deleted, listed in the errors with its path) and keeps it on disk; the next ordinary sync never uploads
// such a file and retries the local deletion, also after an app restart; a file edited after the mirror is kept and
// uploaded as a local edit; and a sync that still cannot delete the file leaves the server untouched. The matrix covers
// sync history x failure scope x edit after the mirror x restart. Each test uses its own remote workspace.
import { describeLive, LiveEnv } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { Device, makeDevice, restartDevice } from '../support/engineDevice';
import { mirror, expectQuiet, remoteFingerprint } from '../support/mirrorTestKit';

const TEST_TIMEOUT = 180_000;

const FILES = ['e0.md', 'e1.md', 'e2.md'];
const EDITED = 'edited after the mirror\n';

const note = (label: string, i: number): string => `---\ntags:\n  - t\n---\n# n\n\n${label} ${i}\n`;

type History = 'synced' | 'never synced';
type Scope = 'one fails' | 'all fail';

interface Case {
  history: History;
  scope: Scope;
  edited: boolean;
  restart: boolean;
}

const CASES: Case[] = [];
for (const history of ['synced', 'never synced'] as const) {
  for (const scope of ['one fails', 'all fail'] as const) {
    for (const edited of [false, true]) {
      for (const restart of [false, true]) CASES.push({ history, scope, edited, restart });
    }
  }
}

function without(fp: Record<string, string>, key: string): Record<string, string> {
  const copy = { ...fp };
  delete copy[key];
  return copy;
}

describeLive('Layer B (MDF-B1) - a mirror that cannot delete a local-only file, against a live server', (getEnv) => {
  let ws: IsolatedWorkspace;
  let baseClient: NextcloudClient;

  beforeEach(async () => {
    const s = await setupWorkspace(getEnv());
    ws = s.ws;
    baseClient = s.client;
  });

  afterEach(async () => {
    if (baseClient && ws) await cleanupWorkspace(baseClient, ws);
  });

  // The remote holds keep/k0..k4 and the target has synced once, so the target's state knows the remote.
  async function prepareTarget(env: LiveEnv, id: string): Promise<Device> {
    const seed = makeDevice(env, ws.remoteBase, `seed-${id}`);
    for (let i = 0; i < 5; i++) seed.vault.seedLocal(`keep/k${i}.md`, note('keep', i));
    await seed.sync();
    const target = makeDevice(env, ws.remoteBase, `target-${id}`);
    await target.sync();
    return target;
  }

  it.each(CASES)(
    '[SPEC:MDF-B1-1]: history $history, $scope, edited after the mirror $edited, restart $restart',
    async ({ history, scope, edited, restart }) => {
      const env = getEnv();
      const id = `${history === 'synced' ? 's' : 'n'}${scope === 'one fails' ? '1' : 'a'}${edited ? 'e' : 'u'}${restart ? 'r' : 'c'}`;
      let target = await prepareTarget(env, id);

      // 1. History: files that were synced and then removed on the server, or files that were never synced.
      for (let i = 0; i < FILES.length; i++) target.vault.seedLocal(FILES[i], note('local', i));
      if (history === 'synced') {
        await target.sync();
        for (const p of FILES) await baseClient.deleteFile(p, '');
      }

      // 2. The local deletion fails for the chosen files.
      const failing = scope === 'one fails' ? ['e0.md'] : [...FILES];
      const restore = target.vault.failTrashFor(failing);

      // 3. The mirror reports exactly the failed files and keeps them on disk.
      const { plan, result } = await mirror(target);
      expect(plan.ok).toBe(true);
      expect(plan.deleteFiles).toHaveLength(3);
      expect(result.deleted).toBe(3 - failing.length);
      expect(result.errors.map((e) => e.path).sort()).toEqual([...failing].sort());
      for (const p of failing) expect(target.vault.localExists(p)).toBe(true);

      // 4. The user edits one of the files after the mirror.
      if (edited) target.vault.seedLocal('e0.md', EDITED);

      // 5. The app restarts; the vault (and the trash failure hook) is shared with the new device.
      if (restart) target = await restartDevice(env, ws.remoteBase, target);

      // 6. The cause goes away; the next sync retries the deletion and uploads nothing but a user edit.
      restore();
      const before = await remoteFingerprint(target.client);
      await target.sync();
      const after = await remoteFingerprint(target.client);
      const s = target.engine.getLastSessionSummary()!;
      if (!edited) {
        for (const p of failing) {
          expect(target.vault.localExists(p)).toBe(false);
          expect(target.vault.isTrashed(p)).toBe(true);
        }
        expect(s.uploadedCount).toBe(0);
        expect(after).toEqual(before);
      } else {
        expect(target.vault.localExists('e0.md')).toBe(true);
        expect(target.vault.readLocal('e0.md')).toBe(EDITED);
        expect(s.uploadedCount).toBe(1);
        expect(without(after, 'e0.md')).toEqual(before);
        expect(Object.keys(after)).toContain('e0.md');
        for (const p of failing.filter((f) => f !== 'e0.md')) expect(target.vault.localExists(p)).toBe(false);
      }

      // 7. The sync after that has nothing left to do.
      await target.sync();
      expectQuiet(target);
    },
    TEST_TIMEOUT,
  );

  it('[SPEC:MDF-B1-3]: while the deletion still fails, a sync keeps the file and writes nothing to the server', async () => {
    const env = getEnv();
    const target = await prepareTarget(env, 'm3');
    target.vault.seedLocal('e0.md', note('local', 0));
    const restore = target.vault.failTrashFor(['e0.md']);

    const { result } = await mirror(target);
    expect(result.deleted).toBe(0);
    expect(result.errors.map((e) => e.path)).toEqual(['e0.md']);
    expect(target.vault.localExists('e0.md')).toBe(true);

    const before = await remoteFingerprint(target.client);
    await target.sync(); // the trash failure is still active
    expect(target.vault.localExists('e0.md')).toBe(true);
    expect(target.engine.getLastSessionSummary()!.uploadedCount).toBe(0);
    expect(await remoteFingerprint(target.client)).toEqual(before);

    restore();
    await target.sync();
    expect(target.vault.localExists('e0.md')).toBe(false);
    expect(await remoteFingerprint(target.client)).toEqual(before);

    await target.sync();
    expectQuiet(target);
  }, TEST_TIMEOUT);

  it('[SPEC:MDF-B1-1]: a file that cannot be deleted keeps its folder too; neither reaches the server and both are retried', async () => {
    const env = getEnv();
    const target = await prepareTarget(env, 'm5');
    target.vault.seedLocal('box/inner.md', note('local', 0));
    // The folder that holds the file cannot be trashed either.
    const restore = target.vault.failTrashFor(['box/inner.md']);

    const { result } = await mirror(target);
    expect(result.deleted).toBe(0);
    expect(result.errors.map((e) => e.path).sort()).toEqual(['box', 'box/inner.md']);
    expect(target.vault.localExists('box/inner.md')).toBe(true);
    expect(target.vault.folderExists('box')).toBe(true);

    restore();
    const before = await remoteFingerprint(target.client);
    await target.sync();
    expect(target.vault.localExists('box/inner.md')).toBe(false);
    expect(target.vault.folderExists('box')).toBe(false);
    expect(target.engine.getLastSessionSummary()!.uploadedCount).toBe(0);
    expect(await remoteFingerprint(target.client)).toEqual(before);
    const remoteDirs = (await baseClient.getDirectories('')).map((d) => d.path.replace(/\/+$/, ''));
    expect(remoteDirs).not.toContain('box');

    await target.sync();
    expectQuiet(target);
  }, TEST_TIMEOUT);
});
