// Layer A — chunked upload (CHK-1..4) per report/mock_test.md §3.D.
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { describeLive } from '../support/env';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { setupWorkspace } from '../support/workspace';
import { bytesBuf, buffersEqual, MB } from '../support/helpers';

const CHUNK = 10 * MB; // matches ChunkedUploadStrategy's fixed CHUNK_SIZE_BYTES

describeLive('Layer A — chunked upload (CHK)', (getEnv) => {
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

  it('CHK-1 chunked upload round-trips (>10MB, single+overflow chunk)', async () => {
    const data = bytesBuf(11 * MB);
    await client.uploadChunked('chk1.bin', data, CHUNK);
    expect(buffersEqual(await client.downloadFile('chk1.bin'), data)).toBe(true);
  });

  it('CHK-2 multi-chunk (12MB = 2 chunks) reassembles byte-equal', async () => {
    const data = bytesBuf(12 * MB);
    await client.uploadChunked('chk2.bin', data, CHUNK);
    expect(buffersEqual(await client.downloadFile('chk2.bin'), data)).toBe(true);
  });

  // CHK-3: post-assembly checksum mismatch. Skipped — requires corrupting bytes
  // server-side mid-transfer, which we cannot control on a live server.
  it.skip('CHK-3 post-assembly checksum mismatch → NetworkError (needs byte corruption)', () => undefined);

  // CHK-4: session cleanup on abort. Skipped — reliably forcing a mid-upload
  // failure against a live server is not controllable here.
  it.skip('CHK-4 aborted session is cleaned up (needs forced mid-upload failure)', () => undefined);
});
