// Layer B (MIR-B1): remote-authoritative Pull mirror against a live Nextcloud, driven through the real SyncEngine over
// an in-memory vault. Covers: a mass local-only delete plus download is not halted by the mass-delete breaker, local-only
// folders are removed while a failed listing deletes nothing, and the sync after a mirror (also after an app restart)
// transfers nothing and writes nothing to the server. Remote empty folders, tracked or not, exist locally after a mirror
// and survive the next sync. Each test uses its own remote workspace.
import { describeLive, LiveEnv } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { NetworkError } from '../../../src/types';
import { Device, makeDevice, restartDevice } from '../support/engineDevice';

const TEST_TIMEOUT = 180_000;

async function mirror(d: Device) {
  const plan = await d.engine.planRemoteMirror();
  const result = await d.engine.applyRemoteMirror(plan);
  return { plan, result };
}

function expectQuiet(d: Device): void {
  const s = d.engine.getLastSessionSummary()!;
  expect({
    up: s.uploadedCount, down: s.downloadedCount, del: s.deletedCount,
    merged: s.mergedCount, conflicted: s.conflictedCount, err: s.errorCount,
  }).toEqual({ up: 0, down: 0, del: 0, merged: 0, conflicted: 0, err: 0 });
}

// path -> "etag|lastModified" for every remote file: proof that a sync wrote nothing to the server.
async function remoteFingerprint(client: NextcloudClient): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await client.getFiles('')) out[f.path] = `${f.etag}|${f.lastModified}`;
  return out;
}

const note = (label: string, i: number): string => `---\ntags:\n  - t\n---\n# n\n\n${label} ${i}\n`;

// Local files of a device, without the plugin's own state files.
function userFiles(d: Device): string[] {
  return d.vault.vault.getFiles().map((f) => f.path).filter((p) => !p.startsWith('.obsidian/')).sort();
}

describeLive('Layer B (MIR-B1) - Pull mirror against a live server', (getEnv) => {
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

  // Remote holds 35 notes; the target (empty state) holds 25 of them unchanged, 5 with other content and 40 local-only.
  async function prepareDivergedTarget(env: LiveEnv, id: string): Promise<{ target: Device; remotePaths: string[] }> {
    const seed = makeDevice(env, ws.remoteBase, `seed-${id}`);
    for (let i = 0; i < 30; i++) seed.vault.seedLocal(`notes/${i}.md`, note('body', i));
    await seed.sync();

    const target = makeDevice(env, ws.remoteBase, `target-${id}`);
    for (let i = 0; i < 25; i++) target.vault.seedLocal(`notes/${i}.md`, note('body', i));
    for (let i = 25; i < 30; i++) target.vault.seedLocal(`notes/${i}.md`, note('different', i));
    for (let i = 0; i < 40; i++) target.vault.seedLocal(`local-only/${i}.md`, note('local', i));

    for (let i = 0; i < 5; i++) seed.vault.seedLocal(`notes/new-${i}.md`, note('new', i));
    await seed.sync();

    const remotePaths = (await baseClient.getFiles('')).map((f) => f.path).sort();
    return { target, remotePaths };
  }

  it('[SPEC:MIR-B1-1]: a mass local-only delete and download is not halted; the vault ends equal to the remote', async () => {
    const env = getEnv();
    const { target, remotePaths } = await prepareDivergedTarget(env, 'm1');
    expect(remotePaths).toHaveLength(35);

    const { plan, result } = await mirror(target);

    expect(plan.ok).toBe(true);
    expect(plan.deleteFiles).toHaveLength(40);
    expect(plan.downloads).toHaveLength(10);
    expect(plan.skipCount).toBe(25);
    expect(result.errors).toEqual([]);
    expect(userFiles(target)).toEqual(remotePaths);
    for (let i = 0; i < 40; i++) expect(target.vault.isTrashed(`local-only/${i}.md`)).toBe(true);
  }, TEST_TIMEOUT);

  it('[SPEC:MIR-B1-2]: local-only folders (empty, nested, non-empty) are deleted', async () => {
    const env = getEnv();
    const seed = makeDevice(env, ws.remoteBase, 'seed-m2a');
    for (let i = 0; i < 3; i++) seed.vault.seedLocal(`notes/${i}.md`, note('body', i));
    await seed.sync();

    const target = makeDevice(env, ws.remoteBase, 'target-m2a');
    target.vault.seedFolder('gone/deep');
    target.vault.seedLocal('gone2/a.md', note('local', 0));

    const { plan, result } = await mirror(target);

    expect(plan.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(target.vault.folderExists('gone')).toBe(false);
    expect(target.vault.folderExists('gone/deep')).toBe(false);
    expect(target.vault.folderExists('gone2')).toBe(false);
  }, TEST_TIMEOUT);

  it('[SPEC:MIR-B1-2]: a failed remote listing deletes nothing', async () => {
    const env = getEnv();
    const seed = makeDevice(env, ws.remoteBase, 'seed-m2b');
    for (let i = 0; i < 3; i++) seed.vault.seedLocal(`notes/${i}.md`, note('body', i));
    await seed.sync();

    const bad = makeDevice({ ...env, appPassword: 'wrong-password' }, ws.remoteBase, 'target-m2b');
    bad.vault.seedLocal('local-only/a.md', note('local', 0));
    bad.vault.seedFolder('empty/deep');

    const { plan, result } = await mirror(bad);

    expect(plan.ok).toBe(false);
    expect(result.deleted).toBe(0);
    expect(bad.vault.localExists('local-only/a.md')).toBe(true);
    expect(bad.vault.folderExists('local-only')).toBe(true);
    expect(bad.vault.folderExists('empty/deep')).toBe(true);
  }, TEST_TIMEOUT);

  it('[SPEC:MIR-B1-3]: the sync right after a mirror transfers nothing and leaves the server untouched', async () => {
    const env = getEnv();
    const { target } = await prepareDivergedTarget(env, 'm3');
    await mirror(target);

    const before = await remoteFingerprint(target.client);
    await target.sync();

    expectQuiet(target);
    expect(await remoteFingerprint(target.client)).toEqual(before);
  }, TEST_TIMEOUT);

  it('[SPEC:MIR-B1-4]: after a mirror and an app restart, two syncs transfer nothing and the second short-circuits', async () => {
    const env = getEnv();
    const { target } = await prepareDivergedTarget(env, 'm4');
    await mirror(target);

    const restarted = await restartDevice(env, ws.remoteBase, target);
    const before = await remoteFingerprint(restarted.client);

    await restarted.sync();
    expectQuiet(restarted);
    expect(restarted.stateDB.getRemoteRootEtag()).not.toBeNull();

    await restarted.sync();
    expectQuiet(restarted);
    expect(await remoteFingerprint(restarted.client)).toEqual(before);
  }, TEST_TIMEOUT);

  it('[SPEC:MIR-B1-5]: remote empty folders, tracked or not, exist locally after a mirror and survive the next sync', async () => {
    const env = getEnv();
    const seed = makeDevice(env, ws.remoteBase, 'seed-m5');
    seed.vault.seedLocal('anchor.md', note('anchor', 0));
    await seed.sync();

    const target = makeDevice(env, ws.remoteBase, 'target-m5');
    await target.sync();

    await baseClient.createDirectory('tracked-empty');
    await target.sync(); // the empty folder is created locally and tracked
    expect(target.vault.folderExists('tracked-empty')).toBe(true);
    target.vault.deleteLocalTree('tracked-empty');
    await baseClient.createDirectory('untracked-empty');

    const { plan, result } = await mirror(target);
    expect(plan.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(target.vault.folderExists('tracked-empty')).toBe(true);
    expect(target.vault.folderExists('untracked-empty')).toBe(true);

    const restarted = await restartDevice(env, ws.remoteBase, target);
    await restarted.sync();

    expectQuiet(restarted);
    expect(restarted.vault.folderExists('tracked-empty')).toBe(true);
    expect(restarted.vault.folderExists('untracked-empty')).toBe(true);
    const dirs = (await baseClient.getDirectories('')).map((d) => d.path.replace(/\/$/, ''));
    expect(dirs).toEqual(expect.arrayContaining(['tracked-empty', 'untracked-empty']));
  }, TEST_TIMEOUT);

  it('[SPEC:MIR-B1-6]: after a mirror with one failed download, the next sync downloads only that file and the one after is empty', async () => {
    const env = getEnv();
    const seed = makeDevice(env, ws.remoteBase, 'seed-m6a');
    for (let i = 0; i < 5; i++) seed.vault.seedLocal(`notes/${i}.md`, note('body', i));
    await seed.sync();

    const target = makeDevice(env, ws.remoteBase, 'target-m6a');
    await target.sync();

    for (let i = 0; i < 3; i++) seed.vault.seedLocal(`notes/${i}.md`, note('edited', i));
    await seed.sync();

    const failing = 'notes/1.md';
    const original = target.client.downloadFile.bind(target.client);
    target.client.downloadFile = async (p: string) => {
      if (p === failing) throw new NetworkError(500, 'injected', 'GET');
      return original(p);
    };
    let result;
    try {
      ({ result } = await mirror(target));
    } finally {
      target.client.downloadFile = original;
    }
    expect(result.errors).toHaveLength(1);

    const restarted = await restartDevice(env, ws.remoteBase, target);
    await restarted.sync();
    const s = restarted.engine.getLastSessionSummary()!;
    expect(s.downloadedCount).toBe(1);
    expect(s.uploadedCount).toBe(0);

    await restarted.sync();
    expectQuiet(restarted);
  }, TEST_TIMEOUT);

  it('[SPEC:MIR-B1-6]: an oversized remote file is skipped by the mirror and the next sync stays quiet', async () => {
    const env = getEnv();
    const over = { maxFileSizeMB: 1 };
    const seed = makeDevice(env, ws.remoteBase, 'seed-m6b');
    seed.vault.seedLocal('big.bin', 'x'.repeat(1.5 * 1024 * 1024));
    for (let i = 0; i < 3; i++) seed.vault.seedLocal(`notes/${i}.md`, note('body', i));
    await seed.sync();

    const target = makeDevice(env, ws.remoteBase, 'target-m6b', over);
    await mirror(target);

    const restarted = await restartDevice(env, ws.remoteBase, target, over);
    await restarted.sync();

    expect(restarted.vault.localExists('big.bin')).toBe(false);
    expectQuiet(restarted);
    expect((await baseClient.getFiles('')).map((f) => f.path)).toContain('big.bin');
  }, TEST_TIMEOUT);

  it('[SPEC:MIR-B1-6]: with the state file lost across a mirror, the next sync uploads nothing and the one after is empty', async () => {
    const env = getEnv();
    const seed = makeDevice(env, ws.remoteBase, 'seed-m6c');
    for (let i = 0; i < 25; i++) seed.vault.seedLocal(`notes/${i}.md`, note('body', i));
    await seed.sync();

    const target = makeDevice(env, ws.remoteBase, 'target-m6c');
    await target.sync();

    for (let i = 0; i < 20; i++) seed.vault.seedLocal(`notes/${i}.md`, note('edited', i));
    await seed.sync();

    // Files end post-mirror while the state file stays pre-mirror.
    const statePath = `.obsidian/plugins/nextcloud-sync/state-${target.settings.deviceId}.json`;
    const saved = await target.vault.adapter.read(statePath);
    await mirror(target);
    await target.vault.adapter.write(statePath, saved);

    const restarted = await restartDevice(env, ws.remoteBase, target);
    const before = await remoteFingerprint(restarted.client);
    await restarted.sync();

    const s = restarted.engine.getLastSessionSummary()!;
    expect({
      up: s.uploadedCount, down: s.downloadedCount, merged: s.mergedCount,
      conflicted: s.conflictedCount, err: s.errorCount,
    }).toEqual({ up: 0, down: 0, merged: 0, conflicted: 0, err: 0 });
    expect(await remoteFingerprint(restarted.client)).toEqual(before);

    await restarted.sync();
    expectQuiet(restarted);
  }, TEST_TIMEOUT);

  const versioned = (version: number, i: number): string =>
    `---\nversion: ${version}\ntags:\n  - t\n---\n# n\n\nbody ${i}\n`;

  it('[SPEC:MIR-B1-7]: notes identical on both sides are not uploaded when the baseline is stale on both sides', async () => {
    const env = getEnv();
    const count = 50;
    const target = makeDevice(env, ws.remoteBase, 'target-m7a');
    for (let i = 0; i < count; i++) target.vault.seedLocal(`notes/${i}.md`, versioned(1, i));
    await target.sync();

    const seed = makeDevice(env, ws.remoteBase, 'seed-m7a');
    await seed.sync();
    for (let i = 0; i < count; i++) seed.vault.seedLocal(`notes/${i}.md`, versioned(2, i));
    await seed.sync();

    // Same v2 content on the target, written without syncing: its tracking state still holds v1 for both sides.
    for (let i = 0; i < count; i++) target.vault.seedLocal(`notes/${i}.md`, versioned(2, i));

    const before = await remoteFingerprint(target.client);
    await target.sync();

    const s = target.engine.getLastSessionSummary()!;
    expect({
      up: s.uploadedCount, down: s.downloadedCount, merged: s.mergedCount,
      conflicted: s.conflictedCount, err: s.errorCount,
    }).toEqual({ up: 0, down: 0, merged: 0, conflicted: 0, err: 0 });
    expect(await remoteFingerprint(target.client)).toEqual(before);
    for (let i = 0; i < count; i++) expect(target.vault.readLocal(`notes/${i}.md`)).toBe(versioned(2, i));

    await target.sync();
    expectQuiet(target);
  }, TEST_TIMEOUT);

  it('[SPEC:MIR-B1-7]: a fresh device holding content identical to the remote uploads and downloads nothing', async () => {
    const env = getEnv();
    const count = 50;
    const seed = makeDevice(env, ws.remoteBase, 'seed-m7b');
    for (let i = 0; i < count; i++) seed.vault.seedLocal(`notes/${i}.md`, versioned(1, i));
    await seed.sync();

    const fresh = makeDevice(env, ws.remoteBase, 'fresh-m7b');
    for (let i = 0; i < count; i++) fresh.vault.seedLocal(`notes/${i}.md`, versioned(1, i));

    const before = await remoteFingerprint(fresh.client);
    await fresh.sync();

    const s = fresh.engine.getLastSessionSummary()!;
    expect(s.uploadedCount).toBe(0);
    expect(s.downloadedCount).toBe(0);
    expect(await remoteFingerprint(fresh.client)).toEqual(before);
  }, TEST_TIMEOUT);
});
