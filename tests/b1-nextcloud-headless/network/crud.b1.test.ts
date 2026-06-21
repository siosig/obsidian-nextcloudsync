// Layer A — CRUD and boundaries: UP-1..5, DL-1..2, DEL-1..2, MV-1..2
// per report/mock_test.md §3.B. Live server; skips when env absent.
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { ConflictError } from '../../../src/types';
import { isSafeVaultRelativePath } from '../../../src/network/remotePath';
import { describeLive } from '../support/env';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { setupWorkspace } from '../support/workspace';
import { textBuf, buffersEqual, bytesBuf, INTL_PATH, sha256Hex } from '../support/helpers';

describeLive('Layer A — CRUD + boundaries (UP/DL/DEL/MV)', (getEnv) => {
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

  it('UP-1 PUT sends OC-Checksum and round-trips', async () => {
    const data = textBuf('hello UP-1');
    await client.uploadFile('up1.md', data);
    const back = await client.downloadFile('up1.md');
    expect(buffersEqual(back, data)).toBe(true);
    // recalcChecksum returns the server-persisted SHA-256 (null if unsupported).
    const sum = await client.recalcChecksum('up1.md');
    if (sum) expect(sum).toBe(await sha256Hex(data));
  });

  it('UP-2 reactive MKCOL on a nested path (server 404s missing ancestors → MKCOL → retry)', async () => {
    // The client now treats a 404 missing-parent like 409: MKCOL ancestors then retry.
    // No pre-creation — this exercises the reactive path against the live server.
    const data = textBuf('nested');
    await client.uploadFile('deep/a/b/up2.md', data);
    const back = await client.downloadFile('deep/a/b/up2.md');
    expect(buffersEqual(back, data)).toBe(true);
  });

  it('UP-3 empty (0-byte) file round-trips', async () => {
    const data = new ArrayBuffer(0);
    await client.uploadFile('up3-empty.md', data);
    const back = await client.downloadFile('up3-empty.md');
    expect(back.byteLength).toBe(0);
  });

  it('UP-4 international/special-character path round-trips (reactive MKCOL)', async () => {
    const data = textBuf('intl body');
    await client.uploadFile(INTL_PATH, data);
    const back = await client.downloadFile(INTL_PATH);
    expect(buffersEqual(back, data)).toBe(true);
  });

  it('UP-5 path traversal is rejected by isSafeVaultRelativePath', () => {
    expect(isSafeVaultRelativePath('../escape.md')).toBe(false);
    expect(isSafeVaultRelativePath('a/../../b')).toBe(false);
    expect(isSafeVaultRelativePath('/abs.md')).toBe(false);
    expect(isSafeVaultRelativePath('safe/note.md')).toBe(true);
  });

  it('DL-1 download returns identical bytes', async () => {
    const data = bytesBuf(2048);
    await client.uploadFile('dl1.bin', data);
    const back = await client.downloadFile('dl1.bin');
    expect(buffersEqual(back, data)).toBe(true);
  });

  it('DL-2 download of missing file throws NetworkError(404)', async () => {
    await expect(client.downloadFile('does-not-exist.md')).rejects.toMatchObject({ status: 404 });
  });

  it('DEL-1 delete removes the file', async () => {
    await client.uploadFile('del1.md', textBuf('x'));
    await client.deleteFile('del1.md', '');
    await expect(client.downloadFile('del1.md')).rejects.toMatchObject({ status: 404 });
  });

  it('DEL-2 deleting a missing file is idempotent (no throw)', async () => {
    await expect(client.deleteFile('already-gone.md', '')).resolves.toBeUndefined();
  });

  it('MV-1 move renames and removes the old path', async () => {
    const data = textBuf('move me');
    await client.uploadFile('mv1-src.md', data);
    await client.moveFile('mv1-src.md', 'mv1-dst.md');
    const back = await client.downloadFile('mv1-dst.md');
    expect(buffersEqual(back, data)).toBe(true);
    await expect(client.downloadFile('mv1-src.md')).rejects.toMatchObject({ status: 404 });
  });

  it('MV-2 move onto an existing path conflicts (ConflictError)', async () => {
    await client.uploadFile('mv2-src.md', textBuf('s'));
    await client.uploadFile('mv2-dst.md', textBuf('d'));
    await expect(client.moveFile('mv2-src.md', 'mv2-dst.md')).rejects.toBeInstanceOf(ConflictError);
  });
});
