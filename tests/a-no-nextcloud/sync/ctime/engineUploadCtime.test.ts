// First uploads from the engine (docs/spec.md §9.7): the initial-sync upload and a brand-new local file both
// send the local creation time as X-OC-CTime, unless the server already holds a smaller valid value.
import { RemoteFileInfo, SyncSessionSummary } from '../../../../src/types';
import { sha256 } from '../../../../src/util/hash';
import { buildEngine, makeLocalAdapter, makeSummary, remoteOf, toBuf } from '../../support/engineHarness';
import { spec } from '../../support/specRef';
import type { CreationTimeSupport } from '../../../../src/data/creationTimeProbe';

const PATH = 'notes/new.md';
const BODY = 'hello';
const MTIME = 1_700_000_500_000;
const LOCAL_CTIME = 1_700_000_000_000;

type LocalStats = Map<string, { size: number; mtime: number }>;
interface Internals {
  executePlan(
    plan: {
      uploads: string[]; downloads: string[]; conflicts: string[]; deletes: string[]; unchanged: string[];
      unchangedSignatures: Map<string, { mtime: number; size: number }>;
    },
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

async function runInitialUpload(support: CreationTimeSupport, remote: RemoteFileInfo[] = [], duringUpload?: (files: Record<string, string>) => void) {
  const { adapter, upload, client, size } = setup(support);
  if (duringUpload) upload.mockImplementation(async () => { duringUpload(adapter.files); return 'uploaded' as const; });
  const { engine, stateDB } = await buildEngine(adapter as never, client, {}, { upload });
  // buildEngine's status bar is an empty object; executePlan reports progress through it.
  (engine as unknown as { opts: { statusBar: unknown } }).opts.statusBar = { setProgress: jest.fn() };
  const localFiles: LocalStats = new Map([[PATH, { size, mtime: MTIME }]]);
  await (engine as unknown as Internals).executePlan(
    { uploads: [PATH], downloads: [], conflicts: [], deletes: [], unchanged: [], unchangedSignatures: new Map() },
    remote, makeSummary(), localFiles,
  );
  return { upload, adapter, stateDB };
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

describe('SyncEngine first upload signature (executePlan, docs/spec.md §5.3b)', () => {
  it(`${spec('ETG-1')} takes the stat before the read and does not re-stat after the upload`, async () => {
    const { adapter } = await runInitialUpload('settable');
    expect(adapter.stat).toHaveBeenCalledTimes(1);
    expect(adapter.stat.mock.invocationCallOrder[0]).toBeLessThan(adapter.readBinary.mock.invocationCallOrder[0]);
  });

  it(`${spec('ETG-1')} records the pre-read signature and the hash of the bytes sent`, async () => {
    const { stateDB } = await runInitialUpload('settable');
    const rec = stateDB.getFile(PATH);
    expect(rec).toMatchObject({
      localHash: await sha256(toBuf(BODY)), size: BODY.length, mtime: MTIME, localMtime: MTIME, localSize: BODY.length,
    });
  });

  it(`${spec('ETG-1')} keeps the pre-read signature when the file is saved during the upload`, async () => {
    const { stateDB, adapter } = await runInitialUpload('settable', [], (files) => { files[PATH] = `${BODY} edited`; });
    const rec = stateDB.getFile(PATH);
    // The recorded size and hash describe the bytes that were sent, so the saved edit no longer matches the signature.
    expect(rec?.localSize).toBe(BODY.length);
    expect(rec?.localHash).toBe(await sha256(toBuf(BODY)));
    expect(adapter.files[PATH]).toBe(`${BODY} edited`);
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
