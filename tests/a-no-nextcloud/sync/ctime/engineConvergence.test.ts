// Engine self-healing of creation times (docs/spec.md §9.7): a file whose body is already identical on both sides
// converges to the older creation time with no body transfer, in the decision paths C2 (no baseline, identical
// content), C3 (baseline, nothing changed) and C5 (initial sync, unchanged).
import { FileState, NetworkError, RemoteFileInfo, SyncSessionSummary } from '../../../../src/types';
import { RenameTracker } from '../../../../src/sync/RenameTracker';
import { sha256 } from '../../../../src/util/hash';
import { buildEngine, callProcessRemote, makeLocalAdapter, makeSummary, remoteOf, toBuf } from '../../support/engineHarness';
import { spec } from '../../support/specRef';

const PATH = 'notes/a.md';
const BODY = 'hello';
const MTIME = 1_000;
const OLDER = 1_600_000_000_000;
const NEWER = 1_700_000_000_000;
const OLDEST = 1_500_000_000_000;
const sec = (ms: number): number => ms / 1000;

type Kind = 'C2' | 'C3';
type ClientResult = 'applied' | 'rejected';

interface Rig {
  adapter: ReturnType<typeof makeLocalAdapter>;
  client: { setCreationTime: jest.Mock; moveFile: jest.Mock };
  upload: jest.Mock;
  stateDB: Awaited<ReturnType<typeof buildEngine>>['stateDB'];
  summary: SyncSessionSummary;
  edited: { value: boolean };
  sync(creationMs: number | undefined): Promise<void>;
  syncPath(path: string, creationMs: number | undefined): Promise<void>;
  seed(path: string, over?: Partial<FileState>): void;
}

async function makeRig(kind: Kind, localMs: number | undefined, path = PATH): Promise<Rig> {
  const hash = await sha256(toBuf(BODY));
  const size = new TextEncoder().encode(BODY).length;
  const ctimes: Record<string, number> = localMs === undefined ? {} : { [path]: localMs };
  const adapter = makeLocalAdapter({ [path]: BODY }, { [path]: MTIME }, ctimes, 'settable');
  const upload = jest.fn(async () => 'uploaded' as const);
  const client = {
    setCreationTime: jest.fn(async (): Promise<ClientResult> => 'applied'),
    moveFile: jest.fn(async () => undefined),
  };
  const { engine, stateDB } = await buildEngine(adapter as never, client, {}, { upload });
  const edited = { value: false };
  (engine as unknown as { opts: { isBeingEdited: () => boolean } }).opts.isBeingEdited = () => edited.value;
  const summary = makeSummary();
  const seed = (p: string, over: Partial<FileState> = {}): void => {
    stateDB.setFile({
      path: p, localHash: hash, remoteId: hash, idType: 'sha256', size, mtime: 9_000,
      remoteFileId: 'f1', isConflicted: false, localMtime: MTIME, localSize: size, ...over,
    });
  };
  if (kind === 'C3') seed(path);
  const syncPath = async (p: string, creationMs: number | undefined): Promise<void> => {
    const over: Partial<RemoteFileInfo> = { checksum: hash };
    if (creationMs !== undefined) over.creationTime = creationMs;
    await callProcessRemote(engine, remoteOf(p, BODY, over), summary);
  };
  return { adapter, client, upload, stateDB, summary, edited, sync: (c) => syncPath(path, c), syncPath, seed };
}

function expectNoBodyWork(rig: Rig): void {
  expect(rig.upload).not.toHaveBeenCalled();
  expect(rig.adapter.atomicWrite).not.toHaveBeenCalled();
  expect(rig.adapter.atomicWriteBinary).not.toHaveBeenCalled();
  expect(rig.adapter.writeBinary).not.toHaveBeenCalled();
  expect(rig.summary.uploadedCount + rig.summary.downloadedCount + rig.summary.conflictedCount).toBe(0);
  expect(rig.adapter.files[PATH]).toBe(BODY);
}

describe.each<Kind>(['C2', 'C3'])('SyncEngine creation-time convergence (%s)', (kind) => {
  it(`${spec('CT-6', 'CT-7', 'CT-9')} local older: sets the server once, never the local file, and the next sync is quiet`, async () => {
    const rig = await makeRig(kind, OLDER);
    await rig.sync(NEWER);
    expect(rig.client.setCreationTime).toHaveBeenCalledTimes(1);
    expect(rig.client.setCreationTime).toHaveBeenCalledWith(PATH, sec(OLDER));
    expect(rig.adapter.setCreationTime).not.toHaveBeenCalled();
    await rig.sync(OLDER);
    expect(rig.client.setCreationTime).toHaveBeenCalledTimes(1);
    expect(rig.adapter.setCreationTime).not.toHaveBeenCalled();
    expectNoBodyWork(rig);
  });

  it(`${spec('CT-6', 'CT-7', 'CT-9')} server older: sets the local file once, never the server, and the next sync is quiet`, async () => {
    const rig = await makeRig(kind, NEWER);
    await rig.sync(OLDER);
    expect(rig.adapter.setCreationTime).toHaveBeenCalledTimes(1);
    expect(rig.adapter.setCreationTime).toHaveBeenCalledWith(PATH, OLDER);
    expect(rig.client.setCreationTime).not.toHaveBeenCalled();
    await rig.sync(OLDER);
    expect(rig.adapter.setCreationTime).toHaveBeenCalledTimes(1);
    expect(rig.client.setCreationTime).not.toHaveBeenCalled();
    expectNoBodyWork(rig);
  });

  it(`${spec('CT-6', 'CT-7', 'CT-9')} equal values: no creation-time request on either side`, async () => {
    const rig = await makeRig(kind, OLDER);
    await rig.sync(OLDER);
    await rig.sync(OLDER);
    expect(rig.client.setCreationTime).not.toHaveBeenCalled();
    expect(rig.adapter.setCreationTime).not.toHaveBeenCalled();
    expectNoBodyWork(rig);
  });

  it(`${spec('CT-6', 'CT-7', 'CT-9')} reads the body exactly as often as without the feature and keeps mtime and localMtime`, async () => {
    const control = await makeRig(kind, NEWER);
    await control.sync(undefined);
    const rig = await makeRig(kind, NEWER);
    await rig.sync(OLDER);
    expect(rig.adapter.readBinary.mock.calls.length).toBe(control.adapter.readBinary.mock.calls.length);
    const [before, after] = [control.stateDB.getFile(PATH), rig.stateDB.getFile(PATH)];
    expect(after?.mtime).toBe(before?.mtime);
    expect(after?.localMtime).toBe(before?.localMtime);
    expect(after?.localSize).toBe(before?.localSize);
  });

  it(`${spec('CT-8', 'CT-11', 'CT-12')} server failure (500) clears the root ETag; the next sync applies it`, async () => {
    const rig = await makeRig(kind, OLDER);
    rig.stateDB.setRemoteRootEtag('root-1');
    rig.client.setCreationTime.mockRejectedValueOnce(new NetworkError(500, 'boom', 'PROPPATCH'));
    await rig.sync(NEWER);
    expect(rig.stateDB.getRemoteRootEtag()).toBeNull();
    await rig.sync(NEWER);
    expect(rig.client.setCreationTime).toHaveBeenCalledTimes(2);
    await rig.sync(OLDER);
    expect(rig.client.setCreationTime).toHaveBeenCalledTimes(2);
    expectNoBodyWork(rig);
  });

  it(`${spec('CT-8', 'CT-11', 'CT-12')} a file being edited defers the local fix and clears the root ETag; the next sync fixes it`, async () => {
    const rig = await makeRig(kind, NEWER);
    rig.stateDB.setRemoteRootEtag('root-1');
    rig.edited.value = true;
    await rig.sync(OLDER);
    expect(rig.adapter.setCreationTime).not.toHaveBeenCalled();
    expect(rig.stateDB.getRemoteRootEtag()).toBeNull();
    rig.edited.value = false;
    await rig.sync(OLDER);
    expect(rig.adapter.setCreationTime).toHaveBeenCalledTimes(1);
    expect(rig.adapter.setCreationTime).toHaveBeenCalledWith(PATH, OLDER);
    expectNoBodyWork(rig);
  });

  it(`${spec('CT-8', 'CT-11', 'CT-12')} a server that held a stale newer value after the first upload is fixed locally on the next sync`, async () => {
    const rig = await makeRig(kind, NEWER);
    await rig.sync(OLDER);
    expect(rig.adapter.ctimes[PATH]).toBe(OLDER);
    expect(rig.client.setCreationTime).not.toHaveBeenCalled();
  });

  it(`${spec('CT-8', 'CT-11', 'CT-12')} a rejected server update is not repeated for the same value, only for an older one`, async () => {
    const rig = await makeRig(kind, OLDER);
    rig.client.setCreationTime.mockResolvedValue('rejected');
    await rig.sync(NEWER);
    await rig.sync(NEWER);
    expect(rig.client.setCreationTime).toHaveBeenCalledTimes(1);
    rig.adapter.ctimes[PATH] = OLDEST;
    await rig.sync(NEWER);
    expect(rig.client.setCreationTime).toHaveBeenCalledTimes(2);
    expect(rig.client.setCreationTime).toHaveBeenLastCalledWith(PATH, sec(OLDEST));
    expectNoBodyWork(rig);
  });

  it(`${spec('CT-8', 'CT-11', 'CT-12')} an ineffective local update is not repeated for the same value, only for an older one`, async () => {
    const rig = await makeRig(kind, NEWER);
    rig.adapter.setCreationTime.mockResolvedValue('ineffective');
    await rig.sync(OLDER);
    await rig.sync(OLDER);
    expect(rig.adapter.setCreationTime).toHaveBeenCalledTimes(1);
    await rig.sync(OLDEST);
    expect(rig.adapter.setCreationTime).toHaveBeenCalledTimes(2);
    expect(rig.adapter.setCreationTime).toHaveBeenLastCalledWith(PATH, OLDEST);
    expectNoBodyWork(rig);
  });

  it(`${spec('CT-8', 'CT-11', 'CT-12')} a local update that always rejects is tried once and does not clear the root ETag`, async () => {
    const rig = await makeRig(kind, NEWER);
    rig.stateDB.setRemoteRootEtag('root-1');
    rig.adapter.setCreationTime.mockRejectedValue(new Error('EPERM'));
    await rig.sync(OLDER);
    await rig.sync(OLDER);
    await rig.sync(OLDER);
    expect(rig.adapter.setCreationTime).toHaveBeenCalledTimes(1);
    expect(rig.stateDB.getRemoteRootEtag()).toBe('root-1');
    expectNoBodyWork(rig);
  });
});

describe('SyncEngine creation-time convergence (C5, initial sync unchanged)', () => {
  type Plan = { uploads: string[]; downloads: string[]; conflicts: string[]; deletes: string[]; unchanged: string[] };
  interface Internals {
    executePlan(plan: Plan, remote: RemoteFileInfo[], summary: SyncSessionSummary,
      local: Map<string, { size: number; mtime: number }>): Promise<void>;
  }

  async function run(localMs: number, serverSeries: number[]) {
    const rig = await makeRig('C2', localMs);
    const hash = await sha256(toBuf(BODY));
    const size = new TextEncoder().encode(BODY).length;
    const { engine } = await buildEngine(rig.adapter as never, rig.client, {}, { upload: rig.upload });
    (engine as unknown as { opts: { statusBar: unknown } }).opts.statusBar = { setProgress: jest.fn(), setPhase: jest.fn() };
    const plan: Plan = { uploads: [], downloads: [], conflicts: [], deletes: [], unchanged: [PATH] };
    const local = new Map([[PATH, { size, mtime: MTIME }]]);
    for (const creationTime of serverSeries) {
      const remote = remoteOf(PATH, BODY, { checksum: hash, creationTime });
      await (engine as unknown as Internals).executePlan(plan, [remote], rig.summary, local);
    }
    return rig;
  }

  it(`${spec('CT-6', 'CT-7', 'CT-9')} local older: sets the server once, then the next sync is quiet`, async () => {
    const rig = await run(OLDER, [NEWER, OLDER]);
    expect(rig.client.setCreationTime).toHaveBeenCalledTimes(1);
    expect(rig.client.setCreationTime).toHaveBeenCalledWith(PATH, sec(OLDER));
    expect(rig.adapter.setCreationTime).not.toHaveBeenCalled();
    expectNoBodyWork(rig);
  });

  it(`${spec('CT-6', 'CT-7', 'CT-9')} server older: sets the local file once, then the next sync is quiet`, async () => {
    const rig = await run(NEWER, [OLDER, OLDER]);
    expect(rig.adapter.setCreationTime).toHaveBeenCalledTimes(1);
    expect(rig.adapter.setCreationTime).toHaveBeenCalledWith(PATH, OLDER);
    expect(rig.client.setCreationTime).not.toHaveBeenCalled();
    expectNoBodyWork(rig);
  });

  it(`${spec('CT-6', 'CT-7', 'CT-9')} equal values: no creation-time request`, async () => {
    const rig = await run(OLDER, [OLDER, OLDER]);
    expect(rig.client.setCreationTime).not.toHaveBeenCalled();
    expect(rig.adapter.setCreationTime).not.toHaveBeenCalled();
    expectNoBodyWork(rig);
  });
});

describe.each<['remote' | 'local']>([['remote'], ['local']])('SyncEngine creation-time convergence after a %s rename', (side) => {
  const OLD_PATH = 'notes/old.md';
  const NEW_PATH = 'notes/renamed.md';

  // Tracks the file at OLD_PATH, applies the rename to the state, and leaves the body at NEW_PATH on both sides.
  async function renamed(localMs: number, seedOver: Partial<FileState> = {}) {
    const rig = await makeRig('C2', localMs, NEW_PATH);
    rig.seed(OLD_PATH, seedOver);
    const tracker = new RenameTracker(rig.stateDB, rig.client as never);
    if (side === 'remote') await tracker.applyRemoteRename(OLD_PATH, NEW_PATH);
    else await tracker.applyLocalRename(OLD_PATH, NEW_PATH);
    return rig;
  }

  it(`${spec('CT-6', 'CT-7', 'CT-9')} local older: converges to the older value within two syncs without a body transfer`, async () => {
    const rig = await renamed(OLDER);
    await rig.syncPath(NEW_PATH, NEWER);
    await rig.syncPath(NEW_PATH, OLDER);
    expect(rig.client.setCreationTime).toHaveBeenCalledTimes(1);
    expect(rig.client.setCreationTime).toHaveBeenCalledWith(NEW_PATH, sec(OLDER));
    expect(rig.adapter.setCreationTime).not.toHaveBeenCalled();
    expect(rig.adapter.readBinary).not.toHaveBeenCalled();
    expect(rig.adapter.atomicWriteBinary).not.toHaveBeenCalled();
    expect(rig.upload).not.toHaveBeenCalled();
  });

  it(`${spec('CT-6', 'CT-7', 'CT-9')} server older: converges to the older value within two syncs without a body transfer`, async () => {
    const rig = await renamed(NEWER);
    await rig.syncPath(NEW_PATH, OLDER);
    await rig.syncPath(NEW_PATH, OLDER);
    expect(rig.adapter.setCreationTime).toHaveBeenCalledTimes(1);
    expect(rig.adapter.setCreationTime).toHaveBeenCalledWith(NEW_PATH, OLDER);
    expect(rig.client.setCreationTime).not.toHaveBeenCalled();
    expect(rig.adapter.readBinary).not.toHaveBeenCalled();
    expect(rig.adapter.atomicWriteBinary).not.toHaveBeenCalled();
    expect(rig.upload).not.toHaveBeenCalled();
  });

  it(`${spec('CT-8', 'CT-11', 'CT-12')} the attempt marks follow the rename, so a rejected value is not retried at the new path`, async () => {
    const rig = await renamed(OLDER, { ctimeRemoteAttempt: sec(OLDER) });
    expect(rig.stateDB.getFile(NEW_PATH)?.ctimeRemoteAttempt).toBe(sec(OLDER));
    await rig.syncPath(NEW_PATH, NEWER);
    expect(rig.client.setCreationTime).not.toHaveBeenCalled();
  });

  it(`${spec('CT-8', 'CT-11', 'CT-12')} without the attempt marks the value is tried at most once more, and convergence still holds`, async () => {
    const rig = await renamed(OLDER);
    rig.client.setCreationTime.mockResolvedValue('rejected');
    await rig.syncPath(NEW_PATH, NEWER);
    await rig.syncPath(NEW_PATH, NEWER);
    await rig.syncPath(NEW_PATH, NEWER);
    expect(rig.client.setCreationTime).toHaveBeenCalledTimes(1);
    expect(rig.adapter.readBinary).not.toHaveBeenCalled();
    expect(rig.adapter.atomicWriteBinary).not.toHaveBeenCalled();
    expect(rig.upload).not.toHaveBeenCalled();
  });
});
