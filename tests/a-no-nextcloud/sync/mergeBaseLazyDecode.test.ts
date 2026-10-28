// Merge-base recording must not decode files that never get a base (MB-15) and must keep recording
// the same content for the ones that do (MB-16). Section B: MergeBaseRecorder.recordBytes in isolation.
// Later sections (engine-level, per call site) are appended below by follow-up tasks.
import { MergeBaseRecorder } from '../../../src/sync/session/MergeBaseRecorder';
import { buildEngine, makeSummary, remoteOf, toBuf } from '../support/engineHarness';
import { spec } from '../support/specRef';
import type { RemoteFileInfo, SyncSessionSummary } from '../../../src/types';

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

let decodeSpy: jest.SpyInstance;

beforeEach(() => {
  decodeSpy = jest.spyOn(TextDecoder.prototype, 'decode');
});

afterEach(() => {
  decodeSpy.mockRestore();
});

const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

function makeRecorder(opts: { types: () => readonly string[]; withStore?: boolean }): {
  rec: MergeBaseRecorder;
  map: Map<string, string>;
  set: jest.Mock;
  requestSave: jest.Mock;
} {
  const map = new Map<string, string>();
  const set = jest.fn((p: string, c: string) => { map.set(p, c); });
  const del = jest.fn((p: string) => { map.delete(p); });
  const requestSave = jest.fn();
  const rec = new MergeBaseRecorder({
    ...(opts.withStore === false ? {} : { baseStore: { set, delete: del, requestSave } }),
    autoMergeFileTypes: opts.types,
    isPluginPath: (p: string) => p.startsWith('.obsidian/plugins/'),
  });
  return { rec, map, set, requestSave };
}

// ---------------------------------------------------------------------------------------------
// B. MergeBaseRecorder.recordBytes
// ---------------------------------------------------------------------------------------------

describe(spec('MB-15') + ' recordBytes skips files without a merge base', () => {
  it('does not decode or store a non-text type (png)', () => {
    const { rec, set, requestSave } = makeRecorder({ types: () => ['txt'] });
    decodeSpy.mockClear();
    rec.recordBytes('img/a.png', bytes('png-body'));
    expect(decodeSpy).toHaveBeenCalledTimes(0);
    expect(set).toHaveBeenCalledTimes(0);
    expect(requestSave).toHaveBeenCalledTimes(0);
  });

  it('does not decode or store a plugin path even when its type is an Auto Merge File type', () => {
    const { rec, set } = makeRecorder({ types: () => ['js'] });
    decodeSpy.mockClear();
    rec.recordBytes('.obsidian/plugins/p/main.js', bytes('x'));
    expect(decodeSpy).toHaveBeenCalledTimes(0);
    expect(set).toHaveBeenCalledTimes(0);
  });

  it('does not decode or store a markdown file under the plugin directory', () => {
    const { rec, set } = makeRecorder({ types: () => ['txt'] });
    decodeSpy.mockClear();
    rec.recordBytes('.obsidian/plugins/p/README.md', bytes('x'));
    expect(decodeSpy).toHaveBeenCalledTimes(0);
    expect(set).toHaveBeenCalledTimes(0);
  });

  it('does nothing and does not decode when no base store is injected', () => {
    const { rec } = makeRecorder({ types: () => ['txt'], withStore: false });
    decodeSpy.mockClear();
    expect(() => rec.recordBytes('notes/a.md', bytes('x'))).not.toThrow();
    expect(decodeSpy).toHaveBeenCalledTimes(0);
  });

  it('does not throw for a skipped type even if decoding would throw', () => {
    const { rec } = makeRecorder({ types: () => ['txt'] });
    decodeSpy.mockImplementation(() => { throw new RangeError('Invalid string length'); });
    expect(() => rec.recordBytes('media/clip.mp4', bytes('x'))).not.toThrow();
  });
});

describe(spec('MB-16') + ' recordBytes keeps recording the same base for text files', () => {
  it('records a markdown file even when md is not an Auto Merge File type', () => {
    const { rec, set, requestSave } = makeRecorder({ types: () => ['txt'] });
    decodeSpy.mockClear();
    rec.recordBytes('notes/a.md', bytes('hello md'));
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith('notes/a.md', 'hello md');
    expect(requestSave).toHaveBeenCalledTimes(1);
    expect(decodeSpy).toHaveBeenCalledTimes(1);
  });

  it('records an Auto Merge File type (txt)', () => {
    const { rec, set, requestSave } = makeRecorder({ types: () => ['txt'] });
    decodeSpy.mockClear();
    rec.recordBytes('notes/a.txt', bytes('hello txt'));
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith('notes/a.txt', 'hello txt');
    expect(requestSave).toHaveBeenCalledTimes(1);
    expect(decodeSpy).toHaveBeenCalledTimes(1);
  });

  it('records an empty body as an empty string', () => {
    const { rec, set } = makeRecorder({ types: () => ['txt'] });
    rec.recordBytes('notes/a.md', new ArrayBuffer(0));
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith('notes/a.md', '');
  });

  it('reads the Auto Merge File types at call time', () => {
    let types: string[] = ['txt'];
    const { rec, set } = makeRecorder({ types: () => types });
    rec.recordBytes('data/x.bin', bytes('b1'));
    expect(set).toHaveBeenCalledTimes(0);
    types = ['bin'];
    rec.recordBytes('data/x.bin', bytes('b2'));
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith('data/x.bin', 'b2');
  });

  it('leaves the same stored value as record() for the same content', () => {
    const viaString = makeRecorder({ types: () => ['txt'] });
    const viaBytes = makeRecorder({ types: () => ['txt'] });
    viaString.rec.record('notes/a.md', 'same');
    viaBytes.rec.recordBytes('notes/a.md', bytes('same'));
    expect(viaString.map.get('notes/a.md')).toBe('same');
    expect(viaBytes.map.get('notes/a.md')).toBe('same');
  });
});

// ---------------------------------------------------------------------------------------------
// A. Engine-level: every call site (S1..S7) x file type. Shared by MB-15 (T006) and MB-16 (T010).
// The fake local adapter keeps raw bytes and never uses TextDecoder, so any decode seen by the spy comes
// from the merge-base recording path itself.
// ---------------------------------------------------------------------------------------------

function makeBytesAdapter(files: Map<string, ArrayBuffer>) {
  return {
    stat: jest.fn(async (p: string) => { const b = files.get(p); return b ? { size: b.byteLength, mtime: 1_000 } : null; }),
    exists: jest.fn(async (p: string) => files.has(p)),
    readBinary: jest.fn(async (p: string) => files.get(p) ?? new ArrayBuffer(0)),
    atomicWriteBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files.set(p, d); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files.set(p, d); }),
    remove: jest.fn(async (p: string) => { files.delete(p); }),
    creationTimeSupport: jest.fn(async () => 'untrusted' as const),
    setCreationTime: jest.fn(async () => 'ineffective' as const),
    listVaultFiles: () => [...files.entries()].map(([path, b]) => ({ path, size: b.byteLength, mtime: 1_000 })),
    list: jest.fn(async () => ({ files: [], folders: [] })),
  };
}

type Scenario = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7';
const SCENARIOS: Scenario[] = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'];

interface EngineInternals {
  uploadFile(p: string, h: string, id: string, t: string, r: RemoteFileInfo, s: SyncSessionSummary): Promise<void>;
  downloadFile(r: RemoteFileInfo, id: string, t: string, s: SyncSessionSummary): Promise<void>;
  handleConflict(p: string, b: undefined, r: RemoteFileInfo, id: string, t: string, s: SyncSessionSummary): Promise<void>;
  resolveByPreferLocal(p: string, r: RemoteFileInfo, s: SyncSessionSummary): Promise<void>;
  resolveByPreferRemote(p: string, r: RemoteFileInfo, d: ArrayBuffer, id: string, t: string, s: SyncSessionSummary): Promise<void>;
  executePlan(
    plan: { uploads: string[]; downloads: string[]; conflicts: string[]; deletes: string[]; unchanged: string[] },
    remoteFiles: RemoteFileInfo[], summary: SyncSessionSummary, localFiles: Map<string, { size: number; mtime: number }>,
  ): Promise<void>;
}

// Builds the engine for one scenario, then (after assembly, so assembly decodes are not counted) arms the spy and
// returns the driver. `throwOnDecode` simulates the engine failing when a huge body cannot be decoded.
async function runScenario(scenario: Scenario, path: string, throwOnDecode: boolean) {
  const body = `body-${path}`;
  const otherBody = `BODY-${path}`; // same length as `body`
  const files = new Map<string, ArrayBuffer>();
  if (scenario !== 'S3') files.set(path, toBuf(scenario === 'S5' ? body : body));
  const remoteBytes = toBuf(scenario === 'S5' ? otherBody : body);
  const adapter = makeBytesAdapter(files);
  const upload = jest.fn(async () => 'uploaded' as const);
  const client = { downloadFile: jest.fn(async () => remoteBytes), statFile: jest.fn(async () => null) };
  const { engine, stateDB, baseStore } = await buildEngine(adapter as never, client, {}, { upload });
  (engine as unknown as { opts: { statusBar: unknown } }).opts.statusBar = { setProgress: jest.fn(), setPhase: jest.fn() };
  const e = engine as unknown as EngineInternals;
  const summary = makeSummary();
  const remote = remoteOf(path, scenario === 'S5' ? otherBody : body);

  const drive = (): Promise<void> => {
    switch (scenario) {
      case 'S1': return e.uploadFile(path, 'lh', 'e', 'etag', remoteOf(path, body), summary);
      case 'S2': return e.downloadFile(remote, 'e', 'etag', summary);
      case 'S3': return e.downloadFile(remote, 'e', 'etag', summary);
      case 'S4': return e.handleConflict(path, undefined, remote, 'e', 'etag', summary);
      case 'S5': return e.resolveByPreferLocal(path, remote, summary);
      case 'S6': return e.resolveByPreferRemote(path, remote, toBuf(body), 'e', 'etag', summary);
      case 'S7': return e.executePlan(
        { uploads: [path], downloads: [], conflicts: [], deletes: [], unchanged: [] }, [], summary,
        new Map([[path, { size: toBuf(body).byteLength, mtime: 1_000 }]]));
    }
  };

  decodeSpy.mockClear();
  if (throwOnDecode) decodeSpy.mockImplementation(() => { throw new RangeError('Invalid string length'); });
  return { drive, summary, stateDB, baseStore };
}

const NON_RECORDED_PATHS = ['img/a.png', 'media/clip.mp4', 'archive/a.zip', 'README'];
const CASES: Array<[Scenario, string]> = SCENARIOS.flatMap((s) => NON_RECORDED_PATHS.map((p): [Scenario, string] => [s, p]));

describe(spec('MB-15') + ' engine call sites do not decode files without a merge base', () => {
  it.each(CASES)('%s %s: no decode and no base stored', async (scenario, path) => {
    const h = await runScenario(scenario, path, false);
    await h.drive();
    expect(decodeSpy).toHaveBeenCalledTimes(0);
    expect(h.baseStore.set).toHaveBeenCalledTimes(0);
  });
});

describe(spec('MB-15') + ' engine call sites survive a decode failure for files without a merge base', () => {
  it.each(CASES)('%s %s: sync completes without errors or a conflict flag', async (scenario, path) => {
    const h = await runScenario(scenario, path, true);
    await expect(h.drive()).resolves.toBeUndefined();
    expect(h.summary.errors).toEqual([]);
    expect(h.summary.errorCount).toBe(0);
    const st = h.stateDB.getFile(path);
    expect(st).toBeDefined();
    expect(st!.isConflicted).toBe(false);
  });
});

const RECORDED_PATHS = ['notes/a.md', 'notes/A.MD', 'notes/a.txt', 'notes/a.TXT'];
const RECORDED_CASES: Array<[Scenario, string]> = SCENARIOS.flatMap((s) => RECORDED_PATHS.map((p): [Scenario, string] => [s, p]));

describe(spec('MB-16') + ' engine call sites keep recording the merge base for text files', () => {
  it.each(RECORDED_CASES)('%s %s: decoded exactly once and base stored once', async (scenario, path) => {
    const h = await runScenario(scenario, path, false);
    await h.drive();
    // S5 records the local body, S6 the body passed in, the others the shared body: all equal `body-${path}`.
    const expected = `body-${path}`;
    expect(decodeSpy).toHaveBeenCalledTimes(1);
    expect(h.baseStore.set).toHaveBeenCalledTimes(1);
    expect(h.baseStore.set).toHaveBeenCalledWith(path, expected);
  });
});
