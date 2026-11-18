// Layer B — creation time against a real Nextcloud (docs/spec.md §9.7): the PROPPATCH primitive, convergence of two
// devices that hold the same file with different creation times, and the behaviour through a public link share.
import { describeLive, LiveEnv } from '../support/env';
import { DEFAULT_SETTINGS, RemoteFileInfo } from '../../../src/types';
import { setupWorkspace, ensureParentDirs } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice, Device } from '../support/engineDevice';
import { recordRequests } from '../support/requestRecorder';
import { createPublicShare, deletePublicShare, publicShareEnv, PublicShare } from '../support/publicShare';
import { textBuf, uniquePath } from '../support/helpers';

const C1_MS = Date.UTC(2020, 0, 1); // the older creation time (device A)
const C2_MS = Date.UTC(2021, 0, 1); // the newer creation time (device B)
const TOLERANCE_MS = 1000;

describeLive('Layer B — creation time: PROPPATCH, two-device convergence, public share', (getEnv) => {
  let ws: IsolatedWorkspace;
  let baseClient: NextcloudClient;
  let share: PublicShare | undefined;

  beforeAll(async () => {
    const env = getEnv();
    const s = await setupWorkspace(env);
    ws = s.ws;
    baseClient = s.client;
    share = await createPublicShare(env, ws.remoteBase);
    await ensureParentDirs(env, ws, 'vault-ct19/x.md');
  }, 120_000);

  afterAll(async () => {
    if (share) await deletePublicShare(getEnv(), share);
    if (baseClient && ws) await cleanupWorkspace(baseClient, ws);
  }, 120_000);

  async function serverInfoOf(path: string): Promise<{ creationTime?: number; lastModified: number; etag: string | null } | undefined> {
    return (await baseClient.getFiles('')).find((f) => f.path.endsWith(path));
  }

  // A forced real scan: the list short-circuit would otherwise hide a creation time the server changed by PROPPATCH.
  async function syncWithFullScan(d: Device): Promise<void> {
    d.stateDB.setRemoteRootEtag(null);
    await d.sync();
  }

  function proppatchesOf(rec: ReturnType<typeof recordRequests>, path: string): number {
    return rec.requests.filter((r) => r.method === 'PROPPATCH' && r.url.endsWith(encodeURI(path))).length;
  }

  it('[SPEC:CT-17] setCreationTime applies the value, keeps getlastmodified, and the ETag effect is recorded', async () => {
    const path = uniquePath('ct17');
    const mtime = 1_700_000_000_000;
    const T = 1_600_000_000; // seconds
    await baseClient.uploadFile(path, textBuf('ct17 body'), mtime);

    const before = await serverInfoOf(path);
    expect(before).toBeDefined();
    const rootBefore = await baseClient.getRootEtag();

    expect(await baseClient.setCreationTime(path, T)).toBe('applied'); // [SPEC:CT-17] outcome

    const after = await serverInfoOf(path);
    const rootAfter = await baseClient.getRootEtag();
    expect(after?.creationTime).toBe(T * 1000); // [SPEC:CT-17] nc:creation_time
    expect(after?.lastModified).toBe(before?.lastModified); // [SPEC:CT-17] getlastmodified unchanged

    // Observation only (no assertion): whether a PROPPATCH moves the file ETag and the root ETag.
    console.log(
      `[CT-17] file ETag changed=${before?.etag !== after?.etag}, root ETag changed=${rootBefore !== rootAfter} ` +
        `(file ${String(before?.etag)} -> ${String(after?.etag)}, root ${String(rootBefore)} -> ${String(rootAfter)})`,
    );
  }, 120_000);

  describe.each([
    { order: 'A first', first: 'A', second: 'B' },
    { order: 'B first', first: 'B', second: 'A' },
  ] as const)('[SPEC:CT-18] two devices, $order', ({ order, first, second }) => {
    it(`both devices and the server converge on the older creation time (${order}) without PROPPATCH afterwards`, async () => {
      const path = uniquePath(`ct18-${first.toLowerCase()}`);
      const body = `same body ${order}\n`;
      // The server copy is created without any creation time (nc:creation_time 0).
      await baseClient.uploadFile(path, textBuf(body), 1_700_000_000_000);
      console.log(`[CT-18] ${order}: server nc:creation_time before = ${String((await serverInfoOf(path))?.creationTime)}`);

      const a = makeDevice(getEnv(), ws.remoteBase, `CT18-A-${first}`);
      const b = makeDevice(getEnv(), ws.remoteBase, `CT18-B-${first}`);
      a.vault.seedLocal(path, body);
      a.vault.setCtime(path, C1_MS);
      b.vault.seedLocal(path, body);
      b.vault.setCtime(path, C2_MS);
      const devices: Record<'A' | 'B', Device> = { A: a, B: b };

      // Each device syncs twice, interleaved, each time with a forced real scan. SC-002's worst case (a stale newer
      // value surviving the list short-circuit for up to 21 syncs) is deliberately not exercised here.
      for (let round = 0; round < 2; round++) {
        await syncWithFullScan(devices[first]);
        await syncWithFullScan(devices[second]);
      }

      expect(Math.abs((a.vault.getCtime(path) ?? 0) - C1_MS)).toBeLessThan(TOLERANCE_MS); // [SPEC:CT-18] A
      expect(Math.abs((b.vault.getCtime(path) ?? 0) - C1_MS)).toBeLessThan(TOLERANCE_MS); // [SPEC:CT-18] B
      const onServer = await serverInfoOf(path);
      expect(Math.abs((onServer?.creationTime ?? 0) - C1_MS)).toBeLessThan(TOLERANCE_MS); // [SPEC:CT-18] server

      // The third sync of each device sends no creation-time request.
      const rec = recordRequests();
      try {
        await syncWithFullScan(devices[first]);
        await syncWithFullScan(devices[second]);
      } finally {
        rec.restore();
      }
      expect(rec.requests.filter((r) => r.method === 'PROPPATCH')).toEqual([]); // [SPEC:CT-18] no PROPPATCH
    }, 240_000);
  });

  it('[SPEC:CT-19] a public share sync with a mismatching creation time does not fail and does not retry a rejected PROPPATCH', async () => {
    const shareEnv = publicShareEnv(getEnv(), share as PublicShare, 'token');
    const path = 'ct19-note.md';
    const body = 'ct19 body\n';

    // A first device puts the file on the share; the server then holds whatever the share accepts.
    const a = makeDevice(shareEnv, 'vault-ct19', 'CT19-A');
    a.vault.seedLocal(path, body);
    a.vault.setCtime(path, C2_MS);
    await a.sync();
    expect(a.engine.getLastSessionSummary()?.errorCount).toBe(0);

    // A second device holds the same body with an older creation time, so it tries to lower the server's value.
    const b = makeDevice(shareEnv, 'vault-ct19', 'CT19-B');
    b.vault.seedLocal(path, body);
    b.vault.setCtime(path, C1_MS);
    const outcomes: string[] = [];
    const original = b.client.setCreationTime.bind(b.client);
    b.client.setCreationTime = async (p: string, s: number) => {
      const r = await original(p, s);
      outcomes.push(r);
      return r;
    };

    const rec = recordRequests();
    let first = 0;
    let secondCount = 0;
    try {
      await b.sync();
      expect(b.engine.getLastSessionSummary()?.errorCount).toBe(0); // [SPEC:CT-19] no error, first sync
      first = proppatchesOf(rec, path);
      rec.clear();
      await b.sync();
      expect(b.engine.getLastSessionSummary()?.errorCount).toBe(0); // [SPEC:CT-19] no error, second sync
      secondCount = proppatchesOf(rec, path);
    } finally {
      rec.restore();
    }

    const listed = (await makeShareListing(shareEnv)).find((f) => f.path.endsWith(path));
    console.log(
      `[CT-19] public share: PROPPATCH outcomes=${JSON.stringify(outcomes)}, PROPPATCH requests first=${first} second=${secondCount}, ` +
        `listed creationTime=${String(listed?.creationTime)}`,
    );
    if (outcomes.includes('rejected')) expect(secondCount).toBe(0); // [SPEC:CT-19] a rejection is not retried
  }, 240_000);
});

async function makeShareListing(shareEnv: LiveEnv): Promise<RemoteFileInfo[]> {
  const settings = { ...DEFAULT_SETTINGS, serverUrl: shareEnv.serverUrl, username: shareEnv.username, deviceId: 'CT19-LIST' };
  const c = new NextcloudClient(settings, () => shareEnv.appPassword, 'vault-ct19');
  await c.connect();
  return c.getFiles('');
}
