import { FileState, RemoteFileInfo, SyncSessionSummary } from '../../../src/types';
import { sha256 } from '../../../src/util/hash';
import { MAX_HASH_SIZE } from '../../../src/util/limits';
import { buildEngine, makeSummary, toBuf, callProcessRemote, seedUnrelated } from '../support/engineHarness';

const BIRTH = 1_577_808_000_000;
const MTIME = 1_646_092_800_000;
const DAY = 86_400_000;
const PATH = 'attachment.bin';
type InitialSyncPlan = { uploads: string[]; downloads: string[]; conflicts: string[]; unchanged: string[]; deletes: string[] };

async function setup(body: string, checksum: boolean, localTime = { ctime: BIRTH + DAY, mtime: MTIME + DAY }) {
  const data = toBuf(body);
  const remote: RemoteFileInfo = { path: PATH, fileId: 'file1', etag: 'etag1',
    checksum: checksum ? await sha256(data) : null, size: data.byteLength,
    creationTime: BIRTH, lastModified: MTIME };
  const times = { ...localTime };
  const local = { stat: jest.fn(async () => ({ size: data.byteLength, ...times })),
    readBinary: jest.fn(async () => data), read: jest.fn(async () => body),
    setFileTimes: jest.fn(async (_path: string, wanted: typeof times) => { Object.assign(times, wanted); }),
    atomicWriteBinary: jest.fn(), atomicWrite: jest.fn(), setMtime: jest.fn() };
  const client = { downloadFile: jest.fn(async () => data), statFile: jest.fn(async () => ({ ...remote })),
    setFileTimes: jest.fn(async (_path: string, wanted: typeof times) => {
      Object.assign(remote, { creationTime: wanted.ctime, lastModified: wanted.mtime, etag: 'etag2' });
      return { ...remote };
    }) };
  const upload = jest.fn(async () => 'uploaded' as const);
  const { engine, stateDB } = await buildEngine(local, client, { maxFileSizeMB: 0 }, { upload });
  (engine as unknown as { opts: { statusBar: unknown } }).opts.statusBar = { setProgress: jest.fn() };
  return { engine, stateDB, local, client, upload, remote, times };
}

const base = (): FileState => ({ path: PATH, localHash: 'old', remoteId: 'old', idType: 'etag',
  size: 1, mtime: MTIME, localMtime: MTIME, remoteMtime: MTIME,
  localCtime: BIRTH, remoteCtime: BIRTH, remoteFileId: 'file1', isConflicted: false });

describe('identical-body conflict paths preserve timestamps before advancing state', () => {
  it.each([['large checksum', true], ['missing checksum', false]])(
    'first-sync conflict plan reconciles ctime and mtime: %s', async (_label, checksum) => {
      const body = checksum ? 'x'.repeat(MAX_HASH_SIZE + 1) : 'same body';
      const h = await setup(body, checksum);
      const localFiles = new Map([[PATH, { size: h.remote.size, mtime: h.times.mtime }]]);
      const internals = h.engine as unknown as {
        buildInitialPlan(l: typeof localFiles, r: RemoteFileInfo[]): Promise<InitialSyncPlan>;
        executePlan(p: InitialSyncPlan, r: RemoteFileInfo[], s: SyncSessionSummary, l: typeof localFiles): Promise<void>;
      };
      const plan = await internals.buildInitialPlan(localFiles, [h.remote]);
      expect(plan.conflicts).toEqual([PATH]);
      const summary = makeSummary();
      await internals.executePlan(plan, [h.remote], summary, localFiles);
      expect(summary.errorCount).toBe(0);
      expect(h.times).toEqual({ ctime: BIRTH, mtime: MTIME });
      expect(h.local.setFileTimes).toHaveBeenCalledTimes(1);
      expect(h.upload).not.toHaveBeenCalled();
      expect(h.local.atomicWriteBinary).not.toHaveBeenCalled();
      expect(h.stateDB.getFile(PATH)).toMatchObject({ localCtime: BIRTH, remoteCtime: BIRTH,
        localMtime: MTIME, remoteMtime: MTIME, isConflicted: false });
    });

  it('a checksum-less equal body pushes a local timestamp change against its prior baseline', async () => {
    const h = await setup('same body', false);
    seedUnrelated(h.stateDB);
    h.stateDB.setFile(base());
    await callProcessRemote(h.engine, h.remote, makeSummary());
    expect(h.client.setFileTimes).toHaveBeenCalledWith(PATH,
      { ctime: BIRTH + DAY, mtime: MTIME + DAY }, 'etag1');
    expect(h.local.setFileTimes).not.toHaveBeenCalled();
    expect(h.stateDB.getFile(PATH)).toMatchObject({ localCtime: BIRTH + DAY, remoteCtime: BIRTH + DAY,
      localMtime: MTIME + DAY, remoteMtime: MTIME + DAY, remoteId: 'etag2' });
    expect(h.upload).not.toHaveBeenCalled();
  });

  it('a checksum-less equal body pulls a remote timestamp change against its prior baseline', async () => {
    const h = await setup('same body', false, { ctime: BIRTH, mtime: MTIME });
    Object.assign(h.remote, { creationTime: BIRTH + DAY, lastModified: MTIME + DAY });
    seedUnrelated(h.stateDB);
    h.stateDB.setFile(base());
    await callProcessRemote(h.engine, h.remote, makeSummary());
    expect(h.times).toEqual({ ctime: BIRTH + DAY, mtime: MTIME + DAY });
    expect(h.client.setFileTimes).not.toHaveBeenCalled();
    expect(h.stateDB.getFile(PATH)).toMatchObject({ localCtime: BIRTH + DAY, remoteCtime: BIRTH + DAY });
  });

  it('a concurrent timestamp conflict leaves the old baseline and both copies untouched', async () => {
    const h = await setup('same body', false);
    h.remote.creationTime = BIRTH + 2 * DAY;
    seedUnrelated(h.stateDB);
    h.stateDB.setFile(base());
    await expect(callProcessRemote(h.engine, h.remote, makeSummary())).rejects.toThrow('Both sides changed');
    expect(h.local.setFileTimes).not.toHaveBeenCalled();
    expect(h.client.setFileTimes).not.toHaveBeenCalled();
    expect(h.stateDB.getFile(PATH)).toEqual(base());
  });
});
