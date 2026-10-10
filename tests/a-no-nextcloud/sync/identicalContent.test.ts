// [SPEC:ICN-1..ICN-7] Identical content is never transferred (docs/spec.md §5.3a). Whatever the baseline says
// (none, stale on both sides, stale on one side), when the server checksum or the fetched body proves that the
// local and remote bodies are equal, the engine records a converged state and neither uploads, downloads
// into the vault, nor writes locally. These tests drive the REAL SyncEngine.processRemoteFile.
import { FileState, RemoteFileInfo } from '../../../src/types';
import { sha256 } from '../../../src/util/hash';
import {
  enc, toBuf, makeSummary, makeLocalAdapter, buildEngine, callProcessRemote, remoteOf, seedUnrelated,
} from '../support/engineHarness';

const BODY = '---\ntags:\n  - a\n---\n# Title\n\ntext\n';
const BODY_BYTES = enc.encode(BODY).length;
const PATH = 'note.md';

// A baseline that is stale on both sides: the signature differs from the stat and both ids are old.
const staleBase = (path: string): FileState => ({
  path, localHash: 'old-local', remoteId: 'old-remote', idType: 'sha256',
  size: 1, mtime: 1, remoteFileId: 'f1', isConflicted: false,
});

type Local = ReturnType<typeof makeLocalAdapter>;

const writeCalls = (l: Local): number =>
  l.atomicWrite.mock.calls.length + l.atomicWriteBinary.mock.calls.length + l.writeBinary.mock.calls.length;

const callCounts = (l: Local, download: jest.Mock, upload: jest.Mock): number[] => [
  download.mock.calls.length, upload.mock.calls.length, l.atomicWrite.mock.calls.length,
  l.atomicWriteBinary.mock.calls.length, l.writeBinary.mock.calls.length, l.setMtime.mock.calls.length,
  l.readBinary.mock.calls.length,
];

async function setup(files: Record<string, string>, remoteBody: string = BODY) {
  const local = makeLocalAdapter(files);
  const download = jest.fn(async (_p: string) => toBuf(remoteBody));
  const upload = jest.fn(async (..._a: unknown[]) => 'uploaded' as const);
  const { engine, stateDB } = await buildEngine(local, { downloadFile: download }, {}, { upload });
  seedUnrelated(stateDB);
  return { local, download, upload, engine, stateDB };
}

describe('[SPEC:ICN-1] a stale baseline plus a matching server checksum converges without any transfer', () => {
  it('[SPEC:ICN-1] records the converged state and performs no download, upload or local write', async () => {
    const H = await sha256(toBuf(BODY));
    const { local, download, upload, engine, stateDB } = await setup({ [PATH]: BODY });
    stateDB.setFile(staleBase(PATH));

    await callProcessRemote(engine, remoteOf(PATH, BODY, { checksum: H }), makeSummary());

    expect(download).toHaveBeenCalledTimes(0);
    expect(upload).toHaveBeenCalledTimes(0);
    expect(writeCalls(local)).toBe(0);
    expect(local.files[PATH]).toBe(BODY);
    const s = stateDB.getFile(PATH);
    expect(s).toBeDefined();
    expect(s!.localHash).toBe(H);
    expect(s!.remoteId).toBe(H);
    expect(s!.idType).toBe('sha256');
    expect(s!.isConflicted).toBe(false);
  });
});

describe('[SPEC:ICN-2] without a checksum, an equal fetched body converges without any write or upload', () => {
  it('[SPEC:ICN-2] stale baseline: fetches once for comparison, then records the etag identity', async () => {
    const H = await sha256(toBuf(BODY));
    const { local, download, upload, engine, stateDB } = await setup({ [PATH]: BODY });
    stateDB.setFile(staleBase(PATH));

    await callProcessRemote(engine, remoteOf(PATH, BODY), makeSummary());

    expect(download).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(0);
    expect(writeCalls(local)).toBe(0);
    expect(local.files[PATH]).toBe(BODY);
    const s = stateDB.getFile(PATH);
    expect(s!.localHash).toBe(H);
    expect(s!.remoteId).toBe('remote-etag');
    expect(s!.idType).toBe('etag');
  });

  it('[SPEC:ICN-2] no baseline: fetches once for comparison, then records the etag identity', async () => {
    const H = await sha256(toBuf(BODY));
    const { local, download, upload, engine, stateDB } = await setup({ [PATH]: BODY });
    expect(stateDB.getFile(PATH)).toBeUndefined();

    await callProcessRemote(engine, remoteOf(PATH, BODY), makeSummary());

    expect(download).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(0);
    expect(writeCalls(local)).toBe(0);
    expect(local.files[PATH]).toBe(BODY);
    const s = stateDB.getFile(PATH);
    expect(s!.localHash).toBe(H);
    expect(s!.remoteId).toBe('remote-etag');
    expect(s!.idType).toBe('etag');
  });
});

describe('[SPEC:ICN-3] a remote-only change with an unchanged local signature', () => {
  // The signature equals the stat, so the local file counts as unchanged without being read.
  const signedBase = (H: string): FileState => ({
    path: PATH, localHash: H, remoteId: 'old-etag', idType: 'etag',
    size: BODY_BYTES, mtime: 1_000, localMtime: 1_000, localSize: BODY_BYTES,
    remoteFileId: 'f1', isConflicted: false,
  });

  it('[SPEC:ICN-3] a matching checksum converges without reading the local file', async () => {
    const H = await sha256(toBuf(BODY));
    const { local, download, upload, engine, stateDB } = await setup({ [PATH]: BODY });
    stateDB.setFile(signedBase(H));

    await callProcessRemote(engine, remoteOf(PATH, BODY, { checksum: H }), makeSummary());

    expect(local.readBinary).toHaveBeenCalledTimes(0);
    expect(download).toHaveBeenCalledTimes(0);
    expect(upload).toHaveBeenCalledTimes(0);
    expect(writeCalls(local)).toBe(0);
    const s = stateDB.getFile(PATH);
    expect(s!.remoteId).toBe(H);
    expect(s!.idType).toBe('sha256');
  });

  it('[SPEC:ICN-3] a changed etag with an equal fetched body is not written and does not touch the mtime', async () => {
    const H = await sha256(toBuf(BODY));
    const { local, download, upload, engine, stateDB } = await setup({ [PATH]: BODY });
    stateDB.setFile(signedBase(H));

    const summary = makeSummary();
    await callProcessRemote(engine, remoteOf(PATH, BODY, { etag: 'new-etag' }), summary);

    expect(download).toHaveBeenCalledTimes(1);
    expect(local.atomicWriteBinary).toHaveBeenCalledTimes(0);
    expect(local.setMtime).toHaveBeenCalledTimes(0);
    expect(upload).toHaveBeenCalledTimes(0);
    expect(summary.downloadedCount).toBe(0);
    const s = stateDB.getFile(PATH);
    expect(s!.remoteId).toBe('new-etag');
    expect(s!.idType).toBe('etag');
  });
});

describe('[SPEC:ICN-4] after convergence the next run does nothing', () => {
  it.each([
    ['checksum', true],
    ['body', false],
  ])('[SPEC:ICN-4] a second run with the same remote adds no calls (proof: %s)', async (_name, withChecksum) => {
    const H = await sha256(toBuf(BODY));
    const { local, download, upload, engine, stateDB } = await setup({ [PATH]: BODY });
    stateDB.setFile(staleBase(PATH));
    const remote: RemoteFileInfo = withChecksum ? remoteOf(PATH, BODY, { checksum: H }) : remoteOf(PATH, BODY);

    await callProcessRemote(engine, remote, makeSummary());
    const before = callCounts(local, download, upload);
    const second = makeSummary();
    await callProcessRemote(engine, remote, second);

    expect(callCounts(local, download, upload)).toEqual(before);
    expect(second.downloadedCount + second.uploadedCount + second.mergedCount + second.conflictedCount).toBe(0);
    expect(local.files[PATH]).toBe(BODY);
  });
});

describe('[SPEC:ICN-5] content that is not identical keeps the existing resolution', () => {
  it('[SPEC:ICN-5] a same-length body that differs by one character reuses the comparison fetch and uploads the merge', async () => {
    const REMOTE = BODY.replace('text', 'tex7');
    expect(enc.encode(REMOTE).length).toBe(BODY_BYTES);
    const { download, upload, engine, stateDB } = await setup({ [PATH]: BODY }, REMOTE);
    stateDB.setFile(staleBase(PATH));

    await callProcessRemote(engine, remoteOf(PATH, REMOTE), makeSummary());

    expect(download).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('[SPEC:ICN-5] different bodies with a different checksum are still merged or flagged as a conflict', async () => {
    const REMOTE = '---\ntags:\n  - a\n---\n# Title\n\ntext from the other device\n';
    const checksum = await sha256(toBuf(REMOTE));
    const { engine, stateDB } = await setup({ [PATH]: BODY }, REMOTE);
    stateDB.setFile(staleBase(PATH));

    const summary = makeSummary();
    await callProcessRemote(engine, remoteOf(PATH, REMOTE, { checksum }), summary);

    expect(summary.mergedCount + summary.conflictedCount).toBe(1);
  });

  it('[SPEC:ICN-5] a local body holding a complete marker set stays safe-held and is not uploaded', async () => {
    const MARKED = '<<<<<<< LOCAL\nlocal line\n=======\nremote line\n>>>>>>> REMOTE\n';
    const REMOTE = 'a different remote body\n';
    const checksum = await sha256(toBuf(REMOTE));
    const { local, upload, engine, stateDB } = await setup({ [PATH]: MARKED }, REMOTE);
    stateDB.setFile(staleBase(PATH));

    await callProcessRemote(engine, remoteOf(PATH, REMOTE, { checksum }), makeSummary());

    expect(upload).toHaveBeenCalledTimes(0);
    expect(local.files[PATH]).toBe(MARKED);
    expect(stateDB.getFile(PATH)!.isConflicted).toBe(true);
  });
});

describe('[SPEC:ICN-6] a converged pair is not counted as a conflict, a transfer or a history entry', () => {
  it.each([
    ['checksum', true],
    ['body', false],
  ])('[SPEC:ICN-6] leaves every counter and the history untouched (proof: %s)', async (_name, withChecksum) => {
    const H = await sha256(toBuf(BODY));
    const { engine, stateDB } = await setup({ [PATH]: BODY });
    stateDB.setFile(staleBase(PATH));
    const recordHistory = jest.spyOn(
      (engine as unknown as { journal: { recordHistory: (...a: unknown[]) => unknown } }).journal,
      'recordHistory',
    );

    const summary = makeSummary();
    await callProcessRemote(engine, withChecksum ? remoteOf(PATH, BODY, { checksum: H }) : remoteOf(PATH, BODY), summary);

    expect(summary.uploadedCount).toBe(0);
    expect(summary.downloadedCount).toBe(0);
    expect(summary.deletedCount).toBe(0);
    expect(summary.mergedCount).toBe(0);
    expect(summary.conflictedCount).toBe(0);
    expect(summary.errorCount).toBe(0);
    expect((engine as unknown as { conflictEncounters: number }).conflictEncounters).toBe(0);
    expect(recordHistory).toHaveBeenCalledTimes(0);
  });
});

type BaselineKind = 'none' | 'both-stale' | 'remote-only-stale' | 'local-hash-only-stale';
type Proof = 'checksum' | 'body';
type Kind = { name: string; path: string; content: string };

const KINDS: Kind[] = [
  { name: 'md with frontmatter', path: 'fm.md', content: BODY },
  { name: 'md without frontmatter', path: 'plain.md', content: '# Title\n\njust text\n' },
  { name: 'png', path: 'img.png', content: 'PNG-ish bytes \u0001\u0002 of an image' },
];

const CASES: Array<[string, BaselineKind, Proof, Kind]> = [];
for (const baseline of ['none', 'both-stale', 'remote-only-stale', 'local-hash-only-stale'] as BaselineKind[]) {
  for (const proof of ['checksum', 'body'] as Proof[]) {
    // Not provable: with no checksum and the remote unchanged, only an upload can follow.
    if (baseline === 'local-hash-only-stale' && proof === 'body') continue;
    for (const kind of KINDS) {
      CASES.push([`baseline=${baseline} proof=${proof} kind=${kind.name}`, baseline, proof, kind]);
    }
  }
}

describe('[SPEC:ICN-7] every baseline x proof x file kind combination converges without a transfer', () => {
  it('[SPEC:ICN-7] enumerates exactly 21 combinations', () => {
    expect(CASES).toHaveLength(21);
  });

  it.each(CASES)('[SPEC:ICN-7] %s', async (_name, baseline, proof, kind) => {
    const bytes = enc.encode(kind.content).length;
    const H = await sha256(toBuf(kind.content));
    const { local, download, upload, engine, stateDB } = await setup({ [kind.path]: kind.content }, kind.content);
    // The remote id the server reports now: the checksum when there is one, otherwise the etag.
    const currentId = proof === 'checksum' ? H : 'remote-etag';
    const idType: FileState['idType'] = proof === 'checksum' ? 'sha256' : 'etag';
    const base = {
      path: kind.path, remoteFileId: 'f1', isConflicted: false, size: bytes, mtime: 1_000, idType,
    };
    if (baseline === 'both-stale') {
      stateDB.setFile(staleBase(kind.path));
    } else if (baseline === 'remote-only-stale') {
      stateDB.setFile({
        ...base, localHash: H, remoteId: 'old-remote', localMtime: 1_000, localSize: bytes,
      });
    } else if (baseline === 'local-hash-only-stale') {
      stateDB.setFile({ ...base, localHash: 'old-local', remoteId: currentId });
    }
    const remote = proof === 'checksum'
      ? remoteOf(kind.path, kind.content, { checksum: H })
      : remoteOf(kind.path, kind.content);

    await callProcessRemote(engine, remote, makeSummary());

    expect(upload).toHaveBeenCalledTimes(0);
    expect(local.files[kind.path]).toBe(kind.content);
    expect(writeCalls(local)).toBe(0);
    expect(download).toHaveBeenCalledTimes(proof === 'checksum' ? 0 : 1);

    const before = callCounts(local, download, upload);
    await callProcessRemote(engine, remote, makeSummary());
    expect(callCounts(local, download, upload)).toEqual(before);
    expect(upload).toHaveBeenCalledTimes(0);
    expect(local.files[kind.path]).toBe(kind.content);
  });

  it('[SPEC:ICN-7] 1,600 paths with a stale baseline and a matching checksum cause no upload and no download', async () => {
    const H = await sha256(toBuf(BODY));
    const files: Record<string, string> = {};
    for (let i = 0; i < 1600; i++) files[`n/${i}.md`] = BODY;
    const { local, download, upload, engine, stateDB } = await setup(files);
    for (let i = 0; i < 1600; i++) stateDB.setFile(staleBase(`n/${i}.md`));

    for (let i = 0; i < 1600; i++) {
      await callProcessRemote(engine, remoteOf(`n/${i}.md`, BODY, { checksum: H }), makeSummary());
    }

    expect(upload).toHaveBeenCalledTimes(0);
    expect(download).toHaveBeenCalledTimes(0);
    expect(writeCalls(local)).toBe(0);
  }, 120_000);
});
