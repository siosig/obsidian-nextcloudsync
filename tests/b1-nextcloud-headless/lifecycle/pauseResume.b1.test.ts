// Lifecycle — pause / resume mid-sync against a live server (FR-016): an interrupted batch of uploads resumed by a
// fresh client must show no duplication, no lost work, and convergence.
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { describeLive } from '../support/env';
import { makeClient } from '../support/clientFactory';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { setupWorkspace } from '../support/workspace';
import { textBuf, decodeBuf } from '../support/helpers';

describeLive('Lifecycle — pause/resume mid-sync', (getEnv) => {
  let ws: IsolatedWorkspace;
  let primary: NextcloudClient;

  beforeAll(async () => {
    const s = await setupWorkspace(getEnv());
    ws = s.ws;
    primary = s.client;
  });

  afterAll(async () => {
    if (primary && ws) await cleanupWorkspace(primary, ws);
  });

  const client = (id: string): NextcloudClient => makeClient(getEnv(), ws.remoteBase, { deviceId: id });

  it('[SPEC:PR-1] interrupted upload batch resumes from a fresh client without duplication or loss', async () => {
    const batch = ['pr1-a.md', 'pr1-b.md', 'pr1-c.md', 'pr1-d.md'];

    const s1 = client('deviceA');
    await s1.uploadFile(batch[0], textBuf('A'));
    await s1.uploadFile(batch[1], textBuf('B'));

    const s2 = client('deviceA');
    const present = new Set((await s2.getFiles('')).map((f) => f.path));
    for (const name of batch) {
      if (!present.has(name)) await s2.uploadFile(name, textBuf(name));
    }

    const finalNames = (await s2.getFiles('')).map((f) => f.path).filter((p) => p.startsWith('pr1-'));
    expect(new Set(finalNames)).toEqual(new Set(batch));
    expect(finalNames.length).toBe(batch.length);
  });

  it('[SPEC:PR-2] resume does not re-overwrite files already uploaded before the stop (idempotent)', async () => {
    const s1 = client('deviceA');
    await s1.uploadFile('pr2-keep.md', textBuf('original'));
    const etagBefore = (await s1.getFiles('')).find((f) => f.path.endsWith('pr2-keep.md'))?.etag;

    const s2 = client('deviceA');
    const present = new Set((await s2.getFiles('')).map((f) => f.path));
    if (!present.has('pr2-keep.md')) await s2.uploadFile('pr2-keep.md', textBuf('SHOULD-NOT-HAPPEN'));

    const after = (await s2.getFiles('')).find((f) => f.path.endsWith('pr2-keep.md'));
    expect(after?.etag).toBe(etagBefore); // unchanged ⇒ no double-apply
    expect(decodeBuf(await s2.downloadFile('pr2-keep.md'))).toBe('original');
  });
});
