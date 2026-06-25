// Layer A — file-size boundary (SZ-1..7) per report/mock_test.md §3.C.
// Drives the upload strategies directly with small thresholds.
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { StandardWebDAVClient } from '../../../src/network/StandardWebDAVClient';
import { ChunkedUploadStrategy } from '../../../src/sync/upload/ChunkedUploadStrategy';
import { SimpleUploadStrategy } from '../../../src/sync/upload/SimpleUploadStrategy';
import { describeLive } from '../support/env';
import { makeSettings } from '../support/clientFactory';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { setupWorkspace } from '../support/workspace';
import { bytesBuf, buffersEqual, MB } from '../support/helpers';

describeLive('Layer A — size boundary (SZ)', (getEnv) => {
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

  it('SZ-1 below threshold → single PUT (uploaded)', async () => {
    const strat = new ChunkedUploadStrategy({ uploadChunkThresholdMB: 1, maxFileSizeMB: 0 });
    const data = bytesBuf(0.5 * MB);
    expect(await strat.upload(client, 'sz1.bin', data)).toBe('uploaded');
    expect(buffersEqual(await client.downloadFile('sz1.bin'), data)).toBe(true);
  });

  it('SZ-2 exactly at threshold → single PUT (> semantics)', async () => {
    const strat = new ChunkedUploadStrategy({ uploadChunkThresholdMB: 1, maxFileSizeMB: 0 });
    const data = bytesBuf(1 * MB);
    expect(await strat.upload(client, 'sz2.bin', data)).toBe('uploaded');
    expect((await client.downloadFile('sz2.bin')).byteLength).toBe(1 * MB);
  });

  it('SZ-3 above threshold → chunked (uploaded)', async () => {
    const strat = new ChunkedUploadStrategy({ uploadChunkThresholdMB: 1, maxFileSizeMB: 0 });
    const data = bytesBuf(3 * MB);
    expect(await strat.upload(client, 'sz3.bin', data)).toBe('uploaded');
    expect(buffersEqual(await client.downloadFile('sz3.bin'), data)).toBe(true);
  });

  it('SZ-4 over max size → skipped', async () => {
    const strat = new ChunkedUploadStrategy({ uploadChunkThresholdMB: 1, maxFileSizeMB: 2 });
    const data = bytesBuf(3 * MB);
    expect(await strat.upload(client, 'sz4.bin', data)).toBe('skipped');
  });

  it('SZ-5 exactly at max size → uploaded (> semantics)', async () => {
    const strat = new ChunkedUploadStrategy({ uploadChunkThresholdMB: 10, maxFileSizeMB: 2 });
    const data = bytesBuf(2 * MB);
    expect(await strat.upload(client, 'sz5.bin', data)).toBe('uploaded');
  });

  it('SZ-6 chunked disabled → SimpleUploadStrategy single PUT', async () => {
    const strat = new SimpleUploadStrategy({ maxFileSizeMB: 0, uploadChunkThresholdMB: 0 });
    const data = bytesBuf(3 * MB);
    expect(await strat.upload(client, 'sz6.bin', data)).toBe('uploaded');
    expect(buffersEqual(await client.downloadFile('sz6.bin'), data)).toBe(true);
  });

  it('SZ-7 standard WebDAV client → single PUT', async () => {
    const env = getEnv();
    const std = new StandardWebDAVClient(makeSettings(env), env.appPassword, ws.remoteBase);
    const strat = new SimpleUploadStrategy({ maxFileSizeMB: 0, uploadChunkThresholdMB: 0 });
    const data = bytesBuf(3 * MB);
    expect(await strat.upload(std, 'sz7.bin', data)).toBe('uploaded');
    expect(buffersEqual(await client.downloadFile('sz7.bin'), data)).toBe(true);
  });
});
