// Layer B — multi-device & lifecycle scenarios against a live server.
// Covers the cases that are NOT "both devices already configured & in sync":
//   - a second device configured later (empty state) picks up existing remote files
//   - reinstall (state lost) re-reads remote with stable fileId (no duplication)
//   - concurrent edits: A edits → B edits & syncs → A syncs with a stale validator
// Each "device" is a NextcloudClient with its own deviceId sharing one remote folder.
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { PreconditionFailedError } from '../../../src/types';
import { describeLive } from '../support/env';
import { makeClient } from '../support/clientFactory';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { setupWorkspace } from '../support/workspace';
import { textBuf, decodeBuf } from '../support/helpers';

describeLive('Layer B — multi-device & lifecycle', (getEnv) => {
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

  const deviceClient = (id: string): NextcloudClient => makeClient(getEnv(), ws.remoteBase, { deviceId: id });

  it('MD-1 later-configured device (empty state) sees all files an existing device uploaded', async () => {
    // "A syncs → B is configured fresh" — B starts with no tracking state.
    const a = deviceClient('deviceA');
    await a.uploadFile('md1-note1.md', textBuf('from A 1'));
    await a.uploadFile('md1-note2.md', textBuf('from A 2'));

    const b = deviceClient('deviceB');
    const names = (await b.getFiles('')).map((f) => f.path);
    expect(names).toContain('md1-note1.md');
    expect(names).toContain('md1-note2.md');
  });

  it('MD-2 reinstall (state lost) re-reads remote with a STABLE fileId (basis for no re-duplication)', async () => {
    const a = deviceClient('deviceA');
    await a.uploadFile('md2-keep.md', textBuf('keep me'));
    const before = (await a.getFiles('')).find((f) => f.path.endsWith('md2-keep.md'));
    expect(before?.fileId).toBeTruthy();

    // Reinstall = a fresh client with empty state re-reads the remote.
    const reinstalled = deviceClient('deviceA');
    const after = (await reinstalled.getFiles('')).find((f) => f.path.endsWith('md2-keep.md'));
    // Same fileId ⇒ the engine can reconcile to the existing remote file rather than
    // treat it as a brand-new upload (rename/identity tracking relies on this).
    expect(after?.fileId).toBe(before?.fileId);
  });

  it('MD-3 concurrent edit: A edits → B edits & syncs → A syncs with a STALE validator → 412 (lost-update prevented)', async () => {
    const a = deviceClient('deviceA');
    await a.uploadFile('md3-race.md', textBuf('v1'));
    const staleEtag = (await a.getFiles('')).find((f) => f.path.endsWith('md3-race.md'))?.etag;
    expect(staleEtag).toBeTruthy();

    // Device B overwrites the file → the server etag changes.
    const b = deviceClient('deviceB');
    await b.uploadFile('md3-race.md', textBuf('v2 from B'));

    // Device A uploads with the now-stale If-Match → server refuses (412) so B's edit is not lost.
    await expect(
      a.uploadFile('md3-race.md', textBuf('v3 from A'), undefined, { ifMatchEtag: staleEtag }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);

    // Sanity: B's content is what's on the server.
    expect(decodeBuf(await a.downloadFile('md3-race.md'))).toBe('v2 from B');
  });

  it('MD-4 convergence: after refreshing the validator, A can upload successfully', async () => {
    const a = deviceClient('deviceA');
    await a.uploadFile('md4-conv.md', textBuf('v1'));
    const b = deviceClient('deviceB');
    await b.uploadFile('md4-conv.md', textBuf('v2 from B'));

    // A re-reads the latest etag (the conflict-resolution path), then uploads with it.
    const latest = (await a.getFiles('')).find((f) => f.path.endsWith('md4-conv.md'))?.etag;
    await a.uploadFile('md4-conv.md', textBuf('v3 from A'), undefined, { ifMatchEtag: latest });
    expect(decodeBuf(await a.downloadFile('md4-conv.md'))).toBe('v3 from A');
  });
});
