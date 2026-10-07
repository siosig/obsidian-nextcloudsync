// [SPEC:MWM-3] specs/091-mobile-watch-mode/contracts/watch-wifi-gate.md C-3 — watch operations skipped on cellular ("Wi-Fi only") converge on a live server after the next full sync on Wi-Fi.
//
// Layer B — feature 091, live server. Each case follows the same three steps:
//   1. on Wi-Fi, establish the starting state and run a full sync;
//   2. on cellular, change the vault and call the matching watch operation, then assert the server
//      did NOT change (the "Wi-Fi only" gate skipped the operation with zero side effects);
//   3. back on Wi-Fi, run one full sync and assert the server converged on the local change.
// The connection type is faked through navigator.connection.type, which is exactly what
// SyncEngine.isBlockedByWifiOnly reads in production.
import { describeLive } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice, Device } from '../support/engineDevice';
import { decodeBuf } from '../support/helpers';

describeLive('Layer B — watch mode under "Wi-Fi only" (feature 091)', (getEnv) => {
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

  beforeEach(() => {
    (globalThis as { navigator?: unknown }).navigator ??= {};
  });
  afterEach(() => {
    delete (globalThis.navigator as unknown as Record<string, unknown>).connection;
  });

  const setNetwork = (type: 'wifi' | 'cellular'): void => {
    Object.defineProperty(globalThis.navigator, 'connection', {
      value: { type },
      configurable: true,
      writable: true,
    });
  };

  const device = (tag: string): Device =>
    makeDevice(getEnv(), ws.remoteBase, `mwm3-${tag}`, { syncOnWifiOnly: true, watchOnChangeEnabled: true });

  const remoteText = async (p: string): Promise<string | null> => {
    if ((await baseClient.statFile(p)) === null) return null;
    return decodeBuf(await baseClient.downloadFile(p));
  };

  const remoteDir = (p: string): Promise<boolean> => baseClient.remoteExists(p);

  it('[SPEC:MWM-3] edit', async () => {
    const f = 'mwm3-1-edit.md';
    const d = device('edit');

    setNetwork('wifi');
    d.vault.seedLocal(f, 'base\n');
    await d.sync();

    setNetwork('cellular');
    d.vault.seedLocal(f, 'edited\n');
    await d.engine.syncSingleFile(f);
    expect(await remoteText(f)).toBe('base\n');

    setNetwork('wifi');
    await d.sync();
    expect(await remoteText(f)).toBe('edited\n');
  }, 120_000);

  it('[SPEC:MWM-3] create', async () => {
    const f = 'mwm3-2-create.md';
    const d = device('create');

    setNetwork('wifi');
    await d.sync();

    setNetwork('cellular');
    d.vault.seedLocal(f, 'new\n');
    await d.engine.syncSingleFile(f);
    expect(await remoteText(f)).toBeNull();

    setNetwork('wifi');
    await d.sync();
    expect(await remoteText(f)).toBe('new\n');
  }, 120_000);

  it('[SPEC:MWM-3] delete', async () => {
    const f = 'mwm3-3-delete.md';
    const d = device('delete');

    setNetwork('wifi');
    d.vault.seedLocal(f, 'x\n');
    await d.sync();

    setNetwork('cellular');
    await d.vault.adapter.remove(f);
    await d.engine.deleteSingleFile(f);
    expect(await remoteText(f)).toBe('x\n');
    expect(d.stateDB.getFile(f)).toBeTruthy();

    setNetwork('wifi');
    await d.sync();
    expect(await remoteText(f)).toBeNull();
  }, 120_000);

  it('[SPEC:MWM-3] rename', async () => {
    const a = 'mwm3-4-rename-a.md';
    const b = 'mwm3-4-rename-b.md';
    const d = device('rename');

    setNetwork('wifi');
    d.vault.seedLocal(a, 'r\n');
    await d.sync();

    setNetwork('cellular');
    await d.vault.adapter.rename(a, b);
    await d.engine.renameSingleFile(a, b);
    expect(await remoteText(a)).toBe('r\n');
    expect(await remoteText(b)).toBeNull();

    setNetwork('wifi');
    await d.sync();
    expect(await remoteText(a)).toBeNull();
    expect(await remoteText(b)).toBe('r\n');
  }, 120_000);

  it('[SPEC:MWM-3] folder-create', async () => {
    const dir = 'mwm3-5-folder-create';
    const d = device('folder-create');

    setNetwork('wifi');
    await d.sync();

    setNetwork('cellular');
    d.vault.seedFolder(dir);
    await d.engine.createSingleFolder(dir);
    expect(await remoteDir(dir)).toBe(false);

    setNetwork('wifi');
    await d.sync();
    expect(await remoteDir(dir)).toBe(true);
  }, 120_000);

  it('[SPEC:MWM-3] folder-delete', async () => {
    const dir = 'mwm3-6-folder-delete';
    const d = device('folder-delete');

    setNetwork('wifi');
    d.vault.seedLocal(`${dir}/in.md`, 'i\n');
    await d.sync();

    setNetwork('cellular');
    d.vault.deleteLocalTree(dir);
    await d.engine.deleteSingleFolder(dir);
    expect(await remoteDir(dir)).toBe(true);

    setNetwork('wifi');
    await d.sync();
    expect(await remoteDir(dir)).toBe(false);
  }, 120_000);

  it('[SPEC:MWM-3] folder-rename', async () => {
    const dirA = 'mwm3-7-folder-rename-a';
    const dirB = 'mwm3-7-folder-rename-b';
    const d = device('folder-rename');

    setNetwork('wifi');
    d.vault.seedLocal(`${dirA}/in.md`, 'i\n');
    await d.sync();

    setNetwork('cellular');
    d.vault.seedLocal(`${dirB}/in.md`, 'i\n');
    d.vault.deleteLocalTree(dirA);
    await d.engine.renameSingleFolder(dirA, dirB);
    expect(await remoteDir(dirA)).toBe(true);
    expect(await remoteDir(dirB)).toBe(false);

    setNetwork('wifi');
    await d.sync();
    expect(await remoteDir(dirA)).toBe(false);
    expect(await remoteText(`${dirB}/in.md`)).toBe('i\n');
  }, 120_000);
});
