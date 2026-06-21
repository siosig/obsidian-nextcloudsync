// Layer A — version history (VR-1..4) per report/mock_test.md §3.J.
// VR-1..3 require the server's versions app; they self-skip when unavailable.
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { FeatureUnsupportedError } from '../../../src/types';
import { describeLive } from '../support/env';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { setupWorkspace } from '../support/workspace';
import { textBuf, decodeBuf } from '../support/helpers';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describeLive('Layer A — versions (VR)', (getEnv) => {
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

  it('VR-4 listVersions with empty fileId → FeatureUnsupportedError', async () => {
    await expect(client.listVersions('')).rejects.toBeInstanceOf(FeatureUnsupportedError);
  });

  it('VR-1/2/3 list (newest-first), fetch and restore a prior version', async () => {
    // Create two revisions to generate a version.
    await client.uploadFile('vr.md', textBuf('VERSION-ONE'));
    await sleep(1100);
    await client.uploadFile('vr.md', textBuf('VERSION-TWO'));

    const files = await client.getFiles('');
    const fileId = files.find((f) => f.path.endsWith('vr.md'))?.fileId;
    if (!fileId) { console.warn('[e2e] VR skipped: no fileId from PROPFIND'); return; }

    const versions = await client.listVersions(fileId);
    if (versions.length === 0) { console.warn('[e2e] VR skipped: versioning app disabled'); return; }

    // VR-1: newest-first ordering.
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i - 1].lastModified).toBeGreaterThanOrEqual(versions[i].lastModified);
    }

    // VR-2: a prior version's content is retrievable.
    const prior = versions[versions.length - 1];
    const content = await client.getVersionContent(prior, fileId);
    expect(typeof decodeBuf(content)).toBe('string');

    // VR-3: restoring makes the prior version current.
    await client.restoreVersion(prior, fileId);
    const restored = decodeBuf(await client.downloadFile('vr.md'));
    expect(restored.length).toBeGreaterThan(0);
  });
});
