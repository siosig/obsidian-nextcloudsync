// A Server URL whose trailing subfolder does not exist (docs/spec.md §11.2, GitHub issue #63). Live server.
import { MISSING_PARENT_HINT, MissingParentFolderError, NetworkError, RemoteDirCreateError } from '../../../src/types';
import { describeLive } from '../support/env';
import { baseUrlOf, makeClient } from '../support/clientFactory';
import { textBuf } from '../support/helpers';

describeLive('Missing Server URL subfolder — HTTP 409 on MKCOL carries the hint (SU)', (getEnv) => {
  const rand = Math.random().toString(36).slice(2, 8);
  const subfolder = `e2e-missing-sub-${Date.now()}-${rand}`;
  const vault = 'Vault';

  // remoteBase '' makes this client act on the files root, so it can create and remove the subfolder itself.
  const rootClient = () => makeClient(getEnv(), '');
  const clientBehindSubfolder = () => makeClient(getEnv(), vault, { serverUrl: `${baseUrlOf(getEnv())}/${subfolder}` });

  afterAll(async () => {
    await rootClient().deleteCollection(subfolder).catch(() => undefined);
  });

  it('[SPEC:SU-3] createVaultRoot fails with the hint while the subfolder is missing', async () => {
    const error = await clientBehindSubfolder().createVaultRoot().then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(MissingParentFolderError);
    expect((error as NetworkError).status).toBe(409);
    expect((error as Error).message.startsWith('HTTP 409 (MKCOL)')).toBe(true);
    expect((error as Error).message).toContain(MISSING_PARENT_HINT);
  });

  it('[SPEC:SU-3] an upload fails with the hint while the subfolder is missing', async () => {
    const error = await clientBehindSubfolder().uploadFile('note.md', textBuf('x')).then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(NetworkError);
    expect([RemoteDirCreateError, MissingParentFolderError].some((type) => error instanceof type)).toBe(true);
    expect((error as Error).message).toContain(MISSING_PARENT_HINT);
  });

  it('[SPEC:SU-3] once the subfolder exists the same client succeeds (the hint was the only obstacle)', async () => {
    await rootClient().createDirectory(subfolder);

    const client = clientBehindSubfolder();
    await expect(client.createVaultRoot()).resolves.toBe('created');
    await client.uploadFile('note.md', textBuf('hello'));
    const back = await client.downloadFile('note.md');
    expect(new TextDecoder().decode(back)).toBe('hello');
  });
});
