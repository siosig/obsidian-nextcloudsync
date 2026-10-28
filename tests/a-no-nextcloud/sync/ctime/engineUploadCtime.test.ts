// First uploads from the engine (docs/spec.md §9.7): the initial-sync upload and a brand-new local file both
// send the local creation time as X-OC-CTime, unless the server already holds a smaller valid value.
import { RemoteFileInfo, SyncSessionSummary } from '../../../../src/types';
import { buildEngine, makeLocalAdapter, makeSummary, remoteOf } from '../../support/engineHarness';
import { spec } from '../../support/specRef';
import type { CreationTimeSupport } from '../../../../src/data/creationTimeProbe';

const PATH = 'notes/new.md';
const BODY = 'hello';
const MTIME = 1_700_000_500_000;
const LOCAL_CTIME = 1_700_000_000_000;

type LocalStats = Map<string, { size: number; mtime: number }>;
interface Internals {
  executePlan(
    plan: { uploads: string[]; downloads: string[]; conflicts: string[]; deletes: string[]; unchanged: string[] },
    remoteFiles: RemoteFileInfo[], summary: SyncSessionSummary, localFiles: LocalStats,
  ): Promise<void>;
  processLocalModifications(remoteFiles: RemoteFileInfo[], summary: SyncSessionSummary, isFullScan?: boolean): Promise<void>;
  uploadFile(...args: unknown[]): Promise<void>;
}

function setup(support: CreationTimeSupport, ctimes: Record<string, number> = { [PATH]: LOCAL_CTIME }) {
  const base = makeLocalAdapter({ [PATH]: BODY }, { [PATH]: MTIME }, { ...ctimes }, support);
  const size = new TextEncoder().encode(BODY).length;
  const adapter = {
    ...base,
    listVaultFiles: () => [{ path: PATH, size, mtime: MTIME }],
    list: jest.fn(async () => ({ files: [], folders: [] })),
  };
  const upload = jest.fn(async () => 'uploaded' as const);
  const client = { statFile: jest.fn(async () => null) };
  return { adapter, upload, client, size };
}

async function runInitialUpload(support: CreationTimeSupport, remote: RemoteFileInfo[] = []) {
  const { adapter, upload, client, size } = setup(support);
  const { engine } = await buildEngine(adapter as never, client, {}, { upload });
  // buildEngine's status bar is an empty object; executePlan reports progress through it.
  (engine as unknown as { opts: { statusBar: unknown } }).opts.statusBar = { setProgress: jest.fn(), setPhase: jest.fn() };
  const localFiles: LocalStats = new Map([[PATH, { size, mtime: MTIME }]]);
  await (engine as unknown as Internals).executePlan(
    { uploads: [PATH], downloads: [], conflicts: [], deletes: [], unchanged: [] },
    remote, makeSummary(), localFiles,
  );
  return { upload, adapter };
}

async function runNewLocalFile(support: CreationTimeSupport) {
  const { adapter, upload, client } = setup(support);
  const { engine } = await buildEngine(adapter as never, client, {}, { upload });
  const internals = engine as unknown as Internals;
  const uploadFile = jest.spyOn(internals, 'uploadFile');
  await internals.processLocalModifications([], makeSummary(), false);
  return { upload, uploadFile };
}

describe('SyncEngine first upload creation time (executePlan, C4)', () => {
  it(`${spec('CT-4')} sends the local ctime when the server has no such path`, async () => {
    const { upload } = await runInitialUpload('settable');
    expect(upload).toHaveBeenCalledTimes(1);
    const args = upload.mock.calls[0] as unknown as unknown[];
    expect(args[1]).toBe(PATH);
    expect(args[3]).toBe(MTIME);
    expect(args[4]).toEqual({ precomputedSha256: expect.any(String), ctime: LOCAL_CTIME });
  });

  it(`${spec('CT-4')} sends the ctime on a readOnly platform as well`, async () => {
    const { upload } = await runInitialUpload('readOnly');
    expect((upload.mock.calls[0] as unknown as unknown[])[4]).toMatchObject({ ctime: LOCAL_CTIME });
  });

  it(`${spec('CT-4')} sends ctime undefined when the platform is untrusted`, async () => {
    const { upload } = await runInitialUpload('untrusted');
    const opts = (upload.mock.calls[0] as unknown as unknown[])[4] as { ctime?: number; precomputedSha256: string };
    expect(opts.ctime).toBeUndefined();
    expect(opts.precomputedSha256).toEqual(expect.any(String));
  });

  it(`${spec('CT-4')} keeps the smaller server value when the path already exists remotely`, async () => {
    const earlier = 1_600_000_000_000;
    const { upload } = await runInitialUpload('settable', [remoteOf(PATH, BODY, { creationTime: earlier })]);
    expect((upload.mock.calls[0] as unknown as unknown[])[4]).toMatchObject({ ctime: earlier });
  });

  it(`${spec('CT-4')} sends the smaller local value when the server value is larger`, async () => {
    const later = 1_800_000_000_000;
    const { upload } = await runInitialUpload('settable', [remoteOf(PATH, BODY, { creationTime: later })]);
    expect((upload.mock.calls[0] as unknown as unknown[])[4]).toMatchObject({ ctime: LOCAL_CTIME });
  });

  it(`${spec('CT-4')} reads the local stat before the upload is issued`, async () => {
    const { upload, adapter } = await runInitialUpload('settable');
    const statOrder = adapter.stat.mock.invocationCallOrder[0];
    expect(statOrder).toBeLessThan(upload.mock.invocationCallOrder[0]);
  });
});

describe('SyncEngine new local file creation time (processLocalModifications, C6)', () => {
  it(`${spec('CT-4')} passes a synthetic remote with creationTime 0 and uploads the local ctime`, async () => {
    const { upload, uploadFile } = await runNewLocalFile('settable');
    const remoteArg = uploadFile.mock.calls[0][4] as RemoteFileInfo;
    expect(remoteArg.creationTime).toBe(0);
    expect(upload).toHaveBeenCalledTimes(1);
    expect((upload.mock.calls[0] as unknown as unknown[])[4]).toMatchObject({ ctime: LOCAL_CTIME });
  });

  it(`${spec('CT-4')} uploads the local ctime on a readOnly platform`, async () => {
    const { upload } = await runNewLocalFile('readOnly');
    expect((upload.mock.calls[0] as unknown as unknown[])[4]).toMatchObject({ ctime: LOCAL_CTIME });
  });

  it(`${spec('CT-4')} uploads ctime undefined on an untrusted platform`, async () => {
    const { upload } = await runNewLocalFile('untrusted');
    const opts = (upload.mock.calls[0] as unknown as unknown[])[4] as { ctime?: number };
    expect(opts.ctime).toBeUndefined();
  });
});
