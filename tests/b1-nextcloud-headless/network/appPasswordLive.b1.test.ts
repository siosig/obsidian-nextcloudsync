// Layer B (APW-B1): one SyncEngine instance follows the app password across syncs without a restart, against a live
// Nextcloud (docs/spec.md §15.2). The password is read through a mutable reader, so a value that is wrong at start-up
// and rewritten afterwards (and the reverse, after the connection exists) must apply from the next sync. The engine,
// its client and its stores are created once; `makeDevice` and `restartDevice` are never called after that, because a
// rebuilt engine would pass even without the live read. Only two syncs use a wrong value, to keep the delay added by
// the server's brute-force protection small. Each run uses its own remote workspace.
import { describeLive } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { Device, makeDevice } from '../support/engineDevice';

const TEST_TIMEOUT = 180_000;
const WRONG_PASSWORD = 'wrong-password';

interface SessionOutcome {
  errorCount: number;
  messages: string[];
}

// The outcome of the sync that just ran, read from the same status report the plugin shows.
function lastOutcome(d: Device): SessionOutcome {
  const summary = d.engine.getStatusReport().summary;
  return {
    errorCount: summary?.errorCount ?? -1,
    messages: (summary?.errors ?? []).map((e) => e.message),
  };
}

describeLive('Layer B (APW-B1) - the app password applies to the next sync without a restart', (getEnv) => {
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

  it('[SPEC:APW-B1-1] one engine follows the app password across syncs without a restart', async () => {
    const env = getEnv();
    let pw = WRONG_PASSWORD;
    const d = makeDevice(env, ws.remoteBase, 'apw-b1', {}, undefined, undefined, () => pw);

    // 1. Started with a wrong value: the sync fails with an authentication error.
    await d.sync();
    const first = lastOutcome(d);
    expect(first.errorCount).toBeGreaterThanOrEqual(1);
    expect(first.messages.some((m) => m.includes('401'))).toBe(true);

    // 2. The value is rewritten after start-up: the next sync of the same engine authenticates.
    pw = env.appPassword;
    await d.sync();
    expect(lastOutcome(d).errorCount).toBe(0);

    // 3. A connection now exists and a local file is waiting; a wrong value fails the next sync.
    d.vault.seedLocal('apw.md', 'apw');
    pw = WRONG_PASSWORD;
    await d.sync();
    const third = lastOutcome(d);
    expect(third.errorCount).toBeGreaterThanOrEqual(1);
    expect(third.messages.some((m) => m.includes('401'))).toBe(true);

    // 4. The correct value is restored: the same engine recovers and uploads the waiting file.
    pw = env.appPassword;
    await d.sync();
    expect(lastOutcome(d).errorCount).toBe(0);
    expect(await d.client.statFile('apw.md')).not.toBeNull();
  }, TEST_TIMEOUT);
});
