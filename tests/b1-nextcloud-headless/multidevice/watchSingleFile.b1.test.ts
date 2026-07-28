// [SPEC:WSF-9] specs/064-watch-single-file-conflict/contracts/watch-single-file-sync.md (C-1 row 7 / C-3)
//
// Layer B — feature 064 (GitHub issue #23 re-report), live server, two devices.
//
// watchSingleFileSync used to PUT the local body straight to the server with no PROPFIND, no base
// comparison and no If-Match, so any edit made on another device since the last sync was silently
// overwritten. This suite proves the watch-mode path (`engine.syncSingleFile`) now goes through the
// SAME classifier as a full sync: a different-line edit on another device survives (merged, not
// dropped), a same-line clash is resolved per `conflictStrategy` exactly like `syncManual` would, the
// two entry points converge on an identical result from the same starting point (C-3), and a
// converged FileState after an upload never triggers a redundant download/upload (C-4).
import { describeLive } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice, Device } from '../support/engineDevice';
import { decodeBuf } from '../support/helpers';

const hasMarkers = (s: string): boolean => /^(?:<<<<<<<|=======|>>>>>>>)/m.test(s);

describeLive('Layer B — watch-mode single-file sync (feature 064 / issue #23)', (getEnv) => {
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

  const remote = (p: string): Promise<string> => baseClient.downloadFile(p).then(decodeBuf);

  it('[SPEC:WSF-9] merges a different-line edit from another device instead of overwriting it (C-1 row 7)', async () => {
    const file = 'wsf9-diffline.md';
    const BASE = 'shared\nfirst base\nsecond base\nthird base\n';
    const D_EDIT = 'shared\nfirst D\nsecond base\nthird base\n';
    const M_EDIT = 'shared\nfirst base\nsecond base\nthird M\n';

    const d: Device = makeDevice(getEnv(), ws.remoteBase, 'wsf9-diffline-D');
    const m: Device = makeDevice(getEnv(), ws.remoteBase, 'wsf9-diffline-M');

    // Baseline: both devices converge on BASE (seeds the merge base for the note).
    d.vault.seedLocal(file, BASE);
    await d.sync();
    await m.sync();
    expect(m.vault.readLocal(file)).toBe(BASE);

    // D edits line 1 and does a full sync -> remote now holds D's change.
    d.vault.seedLocal(file, D_EDIT);
    await d.sync();
    expect(await remote(file)).toBe(D_EDIT);

    // M independently edits a DIFFERENT line (line 3), then syncs through the watch-mode entry
    // point only -- this is the exact repro path from issue #23.
    m.vault.seedLocal(file, M_EDIT);
    await m.engine.syncSingleFile(file);

    // The whole point: M's own edit must survive alongside D's, not be replaced by it.
    const mLocal = m.vault.readLocal(file)!;
    expect(mLocal).toContain('first D');
    expect(mLocal).toContain('third M');
    expect(mLocal).toContain('second base');
    expect(hasMarkers(mLocal)).toBe(false); // non-overlapping edits merge cleanly, no markers
    expect(m.stateDB.getFile(file)?.isConflicted).toBe(false);

    // The clean merge is pushed back so the server and other devices converge too.
    const onServer = await remote(file);
    expect(onServer).toBe(mLocal);

    await d.sync();
    expect(d.vault.readLocal(file)).toBe(mLocal);
  }, 120_000);

  it('[SPEC:WSF-9] resolves a same-line clash per conflictStrategy via watch-mode syncSingleFile (C-1 row 7)', async () => {
    const file = 'wsf9-sameline.md';
    const BASE = 'shared\nvalue base\n';
    const D_EDIT = 'shared\nvalue D\n';
    const M_EDIT = 'shared\nvalue M\n';

    const d: Device = makeDevice(getEnv(), ws.remoteBase, 'wsf9-sameline-D');
    // Default settings -> conflictStrategy is 'conflict-markers'.
    const m: Device = makeDevice(getEnv(), ws.remoteBase, 'wsf9-sameline-M');

    d.vault.seedLocal(file, BASE);
    await d.sync();
    await m.sync();
    expect(m.vault.readLocal(file)).toBe(BASE);

    d.vault.seedLocal(file, D_EDIT);
    await d.sync();
    expect(await remote(file)).toBe(D_EDIT);

    // M edits the SAME line independently, then syncs through watch mode only.
    m.vault.seedLocal(file, M_EDIT);
    await m.engine.syncSingleFile(file);

    const mLocal = m.vault.readLocal(file)!;
    expect(hasMarkers(mLocal)).toBe(true);
    expect(mLocal).toContain('value D');
    expect(mLocal).toContain('value M');
    expect(m.stateDB.getFile(file)?.isConflicted).toBe(true);

    // The marker version reaches the server so the conflict is visible everywhere.
    expect(await remote(file)).toBe(mLocal);
  }, 120_000);

  it('[SPEC:WSF-9] syncSingleFile and syncManual converge on identical content and FileState from the same start (C-3)', async () => {
    const fileSingle = 'wsf9-equiv-single.md';
    const fileManual = 'wsf9-equiv-manual.md';
    const BASE = 'shared\nvalue base\n';
    const D_EDIT = 'shared\nvalue D\n';
    const M_EDIT = 'shared\nvalue M\n';

    const dS: Device = makeDevice(getEnv(), ws.remoteBase, 'wsf9-equiv-single-D');
    const mS: Device = makeDevice(getEnv(), ws.remoteBase, 'wsf9-equiv-single-M');
    const dM: Device = makeDevice(getEnv(), ws.remoteBase, 'wsf9-equiv-manual-D');
    const mM: Device = makeDevice(getEnv(), ws.remoteBase, 'wsf9-equiv-manual-M');

    // Path A: M resolves the clash through engine.syncSingleFile (watch mode).
    dS.vault.seedLocal(fileSingle, BASE);
    await dS.sync();
    await mS.sync();
    dS.vault.seedLocal(fileSingle, D_EDIT);
    await dS.sync();
    mS.vault.seedLocal(fileSingle, M_EDIT);
    await mS.engine.syncSingleFile(fileSingle);

    // Path B: the SAME starting state and edits, but M resolves via a full syncManual instead.
    dM.vault.seedLocal(fileManual, BASE);
    await dM.sync();
    await mM.sync();
    dM.vault.seedLocal(fileManual, D_EDIT);
    await dM.sync();
    mM.vault.seedLocal(fileManual, M_EDIT);
    await mM.sync();

    const singleLocal = mS.vault.readLocal(fileSingle);
    const manualLocal = mM.vault.readLocal(fileManual);
    expect(singleLocal).toBe(manualLocal);

    const singleRemote = await remote(fileSingle);
    const manualRemote = await remote(fileManual);
    expect(singleRemote).toBe(manualRemote);

    const singleState = mS.stateDB.getFile(fileSingle);
    const manualState = mM.stateDB.getFile(fileManual);
    expect(singleState?.remoteId).toBe(manualState?.remoteId);
    expect(singleState?.idType).toBe(manualState?.idType);
    expect(singleState?.isConflicted).toBe(manualState?.isConflicted);
  }, 120_000);

  it('[SPEC:WSF-9] a converged FileState after upload triggers no further download/upload (C-4)', async () => {
    const file = 'wsf9-upload-converged.md';
    const BODY = 'freshly created, only ever seen by this device\n';

    const d: Device = makeDevice(getEnv(), ws.remoteBase, 'wsf9-converged-D');

    d.vault.seedLocal(file, BODY);
    expect(d.stateDB.getFile(file)).toBeUndefined(); // precondition: brand new, untracked

    // C-1 row 4: not on the server at all -> plain upload through watch mode.
    await d.engine.syncSingleFile(file);

    const state = d.stateDB.getFile(file);
    expect(state).toBeDefined();
    expect(state!.remoteId).toBe(state!.localHash);
    expect(state!.idType).toBe('sha256');
    expect(state!.isConflicted).toBe(false);
    expect(await remote(file)).toBe(BODY);

    // C-4: from this converged state, neither another watch-mode sync nor a full sync should touch
    // the network FOR THIS FILE -- spy on the same client instance the engine actually uses.
    // Scoped per path on purpose: this device is fresh and the workspace is shared with the other
    // cases in this file, so its full sync legitimately downloads THEIR notes. Asserting "never
    // called" would fail for a reason that has nothing to do with the clause under test.
    const downloadSpy = jest.spyOn(d.client, 'downloadFile');
    const uploadSpy = jest.spyOn(d.client, 'uploadFile');
    const touched = (spy: jest.SpyInstance): boolean =>
      spy.mock.calls.some(([p]) => p === file);

    await d.engine.syncSingleFile(file); // watch mode: local-unchanged fast path
    await d.sync(); // full sync: converged branch

    expect(touched(downloadSpy)).toBe(false);
    expect(touched(uploadSpy)).toBe(false);
    expect(d.vault.readLocal(file)).toBe(BODY);

    downloadSpy.mockRestore();
    uploadSpy.mockRestore();
  }, 120_000);
});
