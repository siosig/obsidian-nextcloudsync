// Feature 051 — normal (propagation) matrix: a create / modify / delete by any one of the three
// actors (Desktop device D, Mobile device M, Nextcloud server FS N) propagates to the other two and
// all three converge. Strategy-independent (no conflict), so this runs once with defaults.
// Cluster-only: N needs SSH + occ. describeCluster() SKIPS the whole suite (visible in the report,
// never a silent pass) when the cluster env is absent, so the default `pnpm test:b1` stays green.
// Run the matrix via `pnpm test:b1:cluster` (which exports the N-actor env).
import { describeCluster } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeThreeActors, ThreeActors, ActorName } from '../support/threeActor';

const ORIGINS: ActorName[] = ['D', 'M', 'N'];

describeCluster('Layer B — 3-actor propagation matrix (feature 051)', (getEnv) => {
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

  const actorsFor = (suffix: string): ThreeActors => makeThreeActors(getEnv(), ws.remoteBase, suffix);

  // ── create ────────────────────────────────────────────────────────────────
  it.each(ORIGINS)('create by %s propagates to the other two actors', async (origin) => {
    const a = actorsFor(`create-${origin}`);
    const path = `create-${origin}.txt`;
    const content = `created by ${origin}\nline2\n`;
    await a[origin].put(path, content);
    await a.converge(3);
    const v = await a.readAll(path);
    expect(v.D).toBe(content);
    expect(v.M).toBe(content);
    expect(v.N).toBe(content);
  }, 120_000);

  // ── modify (baseline everywhere, then one actor edits) ──────────────────────
  it.each(ORIGINS)('modify by %s propagates to the other two actors', async (origin) => {
    const a = actorsFor(`modify-${origin}`);
    const path = `modify-${origin}.txt`;
    await a.D.put(path, 'base\n');
    await a.converge(3); // establish the baseline on all three
    const edited = `edited by ${origin}\n`;
    await a[origin].put(path, edited);
    await a.converge(3);
    const v = await a.readAll(path);
    expect(v.D).toBe(edited);
    expect(v.M).toBe(edited);
    expect(v.N).toBe(edited);
  }, 120_000);

  // ── delete (baseline everywhere, then one actor deletes) ────────────────────
  it.each(ORIGINS)('delete by %s propagates to the other two actors', async (origin) => {
    const a = actorsFor(`delete-${origin}`);
    const path = `delete-${origin}.txt`;
    await a.D.put(path, 'to be deleted\n');
    await a.converge(3);
    await a[origin].del(path);
    await a.converge(3);
    const v = await a.readAll(path);
    expect(v.D).toBeNull();
    expect(v.M).toBeNull();
    expect(v.N).toBeNull();
  }, 120_000);
});
