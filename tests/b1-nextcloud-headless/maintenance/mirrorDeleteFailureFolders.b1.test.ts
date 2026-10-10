// Layer B (MDF-B1) - local-only folders that a Pull mirror cannot delete, against a live Nextcloud, driven through the
// real SyncEngine over an in-memory vault. Covers every combination of tracked/untracked x one/both folders failing x a
// file added after the mirror x app restart: the next sync never creates the folder on the server, retries the local
// deletion, and keeps a folder (with its uploaded file) when the user added a file to it. Also covers leftovers above
// the mass-delete limit: they are not uploaded, the retry is skipped and reported, and a second mirror clears them.
// Each test uses its own remote workspace.
import { describeLive } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice, restartDevice } from '../support/engineDevice';
import { mirror, expectQuiet, remoteFingerprint } from '../support/mirrorTestKit';

const TEST_TIMEOUT = 180_000;

const note = (label: string, i: number): string => `---\ntags:\n  - t\n---\n# n\n\n${label} ${i}\n`;

const ADDED = 'added after the mirror\n';

type Case = { tracked: boolean; both: boolean; add: boolean; restart: boolean };

const CASES: Case[] = [];
for (const tracked of [true, false]) {
  for (const both of [false, true]) {
    for (const add of [false, true]) {
      for (const restart of [false, true]) CASES.push({ tracked, both, add, restart });
    }
  }
}

const title = (c: Case): string =>
  `${c.tracked ? 'tracked' : 'untracked'}, ${c.both ? 'both fail' : 'one fails'}, ` +
  `${c.add ? 'file added' : 'nothing added'}, ${c.restart ? 'restart' : 'no restart'}`;

describeLive('Layer B (MDF-B1) - mirror delete failure, folders', (getEnv) => {
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

  async function prepareTarget(id: string) {
    const env = getEnv();
    const seed = makeDevice(env, ws.remoteBase, `seed-${id}`);
    for (let i = 0; i < 5; i++) seed.vault.seedLocal(`keep/k${i}.md`, note('keep', i));
    await seed.sync();
    const target = makeDevice(env, ws.remoteBase, `target-${id}`);
    await target.sync();
    return { env, target };
  }

  it.each(CASES.map((c) => [title(c), c] as const))('[SPEC:MDF-B1-2]: %s', async (_name, c) => {
    const { env, target: first } = await prepareTarget('f2');
    let target = first;
    const folders = ['d0', 'd1'];
    const failing = c.both ? ['d0', 'd1'] : ['d0'];

    if (c.tracked) {
      for (const f of folders) target.vault.seedFolder(f);
      await target.sync();
      for (const f of folders) await baseClient.deleteCollection(f);
    } else {
      for (const f of folders) target.vault.seedFolder(f);
    }

    const restore = target.vault.failTrashFor(failing);
    const { result } = await mirror(target);
    expect(result.deleted).toBe(2 - failing.length);
    expect(result.errors.map((e) => e.path).sort()).toEqual([...failing].sort());
    for (const f of failing) expect(target.vault.folderExists(f)).toBe(true);

    if (c.add) target.vault.seedLocal('d0/new.md', ADDED);
    if (c.restart) target = await restartDevice(env, ws.remoteBase, target);
    restore();

    const before = await remoteFingerprint(target.client);
    await target.sync();
    const s = target.engine.getLastSessionSummary()!;
    const remoteDirs = (await baseClient.getDirectories('')).map((d) => d.path.replace(/\/$/, ''));

    if (!c.add) {
      for (const f of failing) expect(target.vault.folderExists(f)).toBe(false);
      expect(remoteDirs).not.toContain('d0');
      expect(remoteDirs).not.toContain('d1');
      expect(s.uploadedCount).toBe(0);
      expect(await remoteFingerprint(target.client)).toEqual(before);
    } else {
      expect(target.vault.folderExists('d0')).toBe(true);
      expect(target.vault.localExists('d0/new.md')).toBe(true);
      expect(s.uploadedCount).toBe(1);
      expect(Object.keys(await remoteFingerprint(target.client))).toContain('d0/new.md');
      for (const f of failing.filter((x) => x !== 'd0')) {
        expect(target.vault.folderExists(f)).toBe(false);
        expect(remoteDirs).not.toContain(f);
      }
    }

    await target.sync();
    expectQuiet(target);
  }, TEST_TIMEOUT);

  it('[SPEC:MDF-B1-4]: leftovers above the mass-delete limit are not uploaded; a second mirror clears them', async () => {
    const { target } = await prepareTarget('f4');
    const paths: string[] = [];
    for (let i = 0; i < 25; i++) {
      paths.push(`m${i}.md`);
      target.vault.seedLocal(`m${i}.md`, note('local', i));
    }

    const restore = target.vault.failTrashFor(paths);
    const first = await mirror(target);
    expect(first.result.errors.length).toBe(25);
    restore();

    const before = await remoteFingerprint(target.client);
    await target.sync();
    const s = target.engine.getLastSessionSummary()!;
    expect(s.uploadedCount).toBe(0);
    expect(await remoteFingerprint(target.client)).toEqual(before);
    for (const p of paths) expect(target.vault.localExists(p)).toBe(true);
    expect(s.errorCount).toBeGreaterThanOrEqual(1);

    const second = await mirror(target);
    expect(second.result.deleted).toBe(25);
    expect(second.result.errors).toEqual([]);

    await target.sync();
    expectQuiet(target);
  }, TEST_TIMEOUT);
});
