// CreationTimeAligner wiring (docs/spec.md §9.7): the plan comes from planCreationTimeAlignment; these tests
// check which operation runs, what is recorded in State, and that align never rejects.
import { CreationTimeAligner } from '../../../../src/sync/ctime/CreationTimeAligner';
import type { FileState, RemoteFileInfo } from '../../../../src/types';
import type { IWebDAVClient } from '../../../../src/network/IWebDAVClient';
import type { LocalStat } from '../../../../src/data/LocalAdapter';
import { spec } from '../../support/specRef';

const PATH = 'notes/a.md';
const OLD = 1_700_000_000;
const NEW = 1_700_000_500;

type LocalResult = 'applied' | 'ineffective' | 'absent' | 'throw';
type RemoteResult = 'applied' | 'rejected' | 'throw';

interface Harness {
  aligner: CreationTimeAligner;
  stat: jest.Mock;
  setLocal: jest.Mock;
  support: jest.Mock;
  getFile: jest.Mock;
  setFile: jest.Mock;
  setRootEtag: jest.Mock;
  isBeingEdited: jest.Mock;
  log: jest.Mock;
  setRemote: jest.Mock;
  client: IWebDAVClient;
}

function makeHarness(opts: {
  support?: 'settable' | 'readOnly' | 'untrusted';
  base?: Partial<FileState> | null;
  localResult?: LocalResult;
  remoteResult?: RemoteResult;
  editing?: boolean;
  statValue?: LocalStat | null;
} = {}): Harness {
  const stat = jest.fn(async () =>
    opts.statValue === undefined ? { size: 11, mtime: 777, ctime: NEW * 1000 } : opts.statValue);
  const setLocal = jest.fn(async () => {
    if (opts.localResult === 'throw') throw new Error('boom');
    return opts.localResult ?? 'applied';
  });
  const support = jest.fn(async () => opts.support ?? 'settable');
  const base: FileState | undefined = opts.base === null ? undefined
    : { path: PATH, localMtime: 1, localSize: 2, ...opts.base } as FileState;
  const getFile = jest.fn(() => base);
  const setFile = jest.fn();
  const setRootEtag = jest.fn();
  const isBeingEdited = jest.fn(() => opts.editing ?? false);
  const log = jest.fn(async () => undefined);
  const setRemote = jest.fn(async () => {
    if (opts.remoteResult === 'throw') throw new Error('net');
    return opts.remoteResult ?? 'applied';
  });
  const aligner = new CreationTimeAligner({
    localAdapter: { stat, setCreationTime: setLocal, creationTimeSupport: support } as never,
    stateDB: { getFile, setFile, setRemoteRootEtag: setRootEtag } as never,
    isBeingEdited,
    logger: { log },
  });
  const client = { setCreationTime: setRemote } as unknown as IWebDAVClient;
  return { aligner, stat, setLocal, support, getFile, setFile, setRootEtag, isBeingEdited, log, setRemote, client };
}

function remote(creationSeconds: number | undefined): RemoteFileInfo {
  return {
    path: PATH, fileId: null, checksum: null, etag: null, size: 11, lastModified: 1,
    creationTime: creationSeconds === undefined ? undefined : creationSeconds * 1000,
  };
}

const stOf = (sec: number | undefined): LocalStat => ({ size: 11, mtime: 5, ctime: sec === undefined ? undefined : sec * 1000 });

function expectLogShape(h: Harness): void {
  for (const call of h.log.mock.calls) {
    expect(String(call[0]).startsWith('ctime: ')).toBe(true);
    expect(String(call[0]).endsWith(` → ${PATH}`)).toBe(true);
  }
}

describe('CreationTimeAligner', () => {
  describe(`${spec('CT-6')} entry conditions`, () => {
    it('does nothing at all when the server value is unknown', async () => {
      const h = makeHarness();
      await h.aligner.align(h.client, remote(undefined));
      expect(h.stat).not.toHaveBeenCalled();
      expect(h.support).not.toHaveBeenCalled();
      expect(h.getFile).not.toHaveBeenCalled();
      expect(h.setLocal).not.toHaveBeenCalled();
      expect(h.setRemote).not.toHaveBeenCalled();
      expect(h.setFile).not.toHaveBeenCalled();
      expect(h.setRootEtag).not.toHaveBeenCalled();
    });

    it('does nothing when the caller says the file is absent (null)', async () => {
      const h = makeHarness();
      await h.aligner.align(h.client, remote(OLD), null);
      expect(h.stat).not.toHaveBeenCalled();
      expect(h.setLocal).not.toHaveBeenCalled();
      expect(h.setRemote).not.toHaveBeenCalled();
    });

    it('stats once here when no stat is passed, and not at all when one is', async () => {
      const h = makeHarness({ statValue: stOf(OLD) });
      await h.aligner.align(h.client, remote(OLD));
      expect(h.stat).toHaveBeenCalledTimes(1);
      expect(h.stat).toHaveBeenCalledWith(PATH);
      const h2 = makeHarness();
      await h2.aligner.align(h2.client, remote(OLD), stOf(OLD));
      expect(h2.stat).not.toHaveBeenCalled();
    });

    it('does nothing when stat here reports the file absent', async () => {
      const h = makeHarness({ statValue: null });
      await h.aligner.align(h.client, remote(OLD));
      expect(h.setLocal).not.toHaveBeenCalled();
      expect(h.setRemote).not.toHaveBeenCalled();
    });

    it(`${spec('CT-7')} issues nothing when both sides match`, async () => {
      const h = makeHarness({ base: { ctimeLocalAttempt: 1, ctimeRemoteAttempt: 2 } });
      await h.aligner.align(h.client, remote(OLD), stOf(OLD));
      expect(h.setLocal).not.toHaveBeenCalled();
      expect(h.setRemote).not.toHaveBeenCalled();
      expect(h.setFile).not.toHaveBeenCalled();
      expect(h.setRootEtag).not.toHaveBeenCalled();
    });
  });

  describe(`${spec('CT-6', 'CT-8')} local fix (local is newer, settable)`, () => {
    it.each([
      ['with', true],
      ['without', false],
    ])('applied %s a base: clears the record and refreshes the signature', async (_n, hasBase) => {
      // The recorded signature equals the pre-set stat (777, 11), so the post-set stat may refresh it.
      const base = hasBase ? { ctimeLocalAttempt: 42, ctimeRemoteAttempt: 43, localMtime: 777, localSize: 11 } : null;
      const h = makeHarness({ base, localResult: 'applied' });
      await h.aligner.align(h.client, remote(OLD), stOf(NEW));
      expect(h.setLocal).toHaveBeenCalledWith(PATH, OLD * 1000);
      expect(h.setRemote).not.toHaveBeenCalled();
      if (!hasBase) { expect(h.setFile).not.toHaveBeenCalled(); return; }
      expect(h.setFile).toHaveBeenCalledTimes(1);
      const saved = h.setFile.mock.calls[0][0] as FileState;
      expect('ctimeLocalAttempt' in saved).toBe(false);
      expect(saved.ctimeRemoteAttempt).toBe(43);
      expect(saved.localMtime).toBe(777);
      expect(saved.localSize).toBe(11);
      expect(saved.path).toBe(PATH);
      expect(h.stat).toHaveBeenCalledWith(PATH);
    });

    it.each([['ineffective' as const], ['throw' as const]])('%s with a base records the attempt for T', async (result) => {
      const h = makeHarness({ base: {}, localResult: result });
      await h.aligner.align(h.client, remote(OLD), stOf(NEW));
      expect(h.setFile).toHaveBeenCalledTimes(1);
      const saved = h.setFile.mock.calls[0][0] as FileState;
      expect(saved.ctimeLocalAttempt).toBe(OLD);
      expect(saved.localMtime).toBe(1);
      expect(h.setRootEtag).not.toHaveBeenCalled();
      if (result === 'throw') expect(h.log).toHaveBeenCalled();
      expectLogShape(h);
    });

    it.each([['ineffective' as const], ['throw' as const], ['absent' as const]])('%s without a base writes no state', async (result) => {
      const h = makeHarness({ base: null, localResult: result });
      await expect(h.aligner.align(h.client, remote(OLD), stOf(NEW))).resolves.toBeUndefined();
      expect(h.setFile).not.toHaveBeenCalled();
      expect(h.setRootEtag).not.toHaveBeenCalled();
    });

    it('absent with a base writes no state', async () => {
      const h = makeHarness({ base: {}, localResult: 'absent' });
      await h.aligner.align(h.client, remote(OLD), stOf(NEW));
      expect(h.setFile).not.toHaveBeenCalled();
    });

    it('defers while the file is being edited: no write, root etag nulled once, one log line', async () => {
      const h = makeHarness({ base: {}, editing: true });
      await h.aligner.align(h.client, remote(OLD), stOf(NEW));
      expect(h.isBeingEdited).toHaveBeenCalledWith(PATH);
      expect(h.setLocal).not.toHaveBeenCalled();
      expect(h.setRootEtag).toHaveBeenCalledTimes(1);
      expect(h.setRootEtag).toHaveBeenCalledWith(null);
      expect(h.log).toHaveBeenCalledTimes(1);
      expect(h.setFile).not.toHaveBeenCalled();
      expectLogShape(h);
    });

    it('does not fix a read-only or untrusted platform locally', async () => {
      for (const support of ['readOnly', 'untrusted'] as const) {
        const h = makeHarness({ support });
        await h.aligner.align(h.client, remote(OLD), stOf(NEW));
        expect(h.setLocal).not.toHaveBeenCalled();
      }
    });

    it('skips the local fix when the record equals T, and retries for another T', async () => {
      const same = makeHarness({ base: { ctimeLocalAttempt: OLD } });
      await same.aligner.align(same.client, remote(OLD), stOf(NEW));
      expect(same.setLocal).not.toHaveBeenCalled();
      const other = makeHarness({ base: { ctimeLocalAttempt: OLD + 50 } });
      await other.aligner.align(other.client, remote(OLD), stOf(NEW));
      expect(other.setLocal).toHaveBeenCalledTimes(1);
    });
  });

  describe(`${spec('ETG-3')} the local creation-time fix keeps the signature honest`, () => {
    const PRE = { size: 11, mtime: 777, ctime: NEW * 1000 };
    const POST = { size: 11, mtime: 999, ctime: OLD * 1000 };

    it('keeps the signature when the record and the stat after the set both equal the stat before it', async () => {
      const h = makeHarness({ base: { ctimeLocalAttempt: 42, localMtime: 777, localSize: 11, localHash: 'h0' } });
      h.stat.mockResolvedValueOnce(PRE).mockResolvedValueOnce({ ...PRE, ctime: OLD * 1000 });
      await h.aligner.align(h.client, remote(OLD), stOf(NEW));
      expect(h.stat).toHaveBeenCalledTimes(2);
      const saved = h.setFile.mock.calls[0][0] as FileState;
      expect(saved.localMtime).toBe(777);
      expect(saved.localSize).toBe(11);
      expect(saved.localHash).toBe('h0');
      expect('ctimeLocalAttempt' in saved).toBe(false);
    });

    it.each([
      ['mtime', POST],
      ['size', { size: 12, mtime: 777, ctime: OLD * 1000 }],
    ])('drops the signature when the stat after the set differs in %s (a save may have landed during the set)', async (_k, after) => {
      // The record equals the pre-set stat, but the file moved during the set: the recorded hash no longer describes it.
      const h = makeHarness({ base: { ctimeLocalAttempt: 42, localMtime: 777, localSize: 11, localHash: 'h0' } });
      h.stat.mockResolvedValueOnce(PRE).mockResolvedValueOnce(after);
      await h.aligner.align(h.client, remote(OLD), stOf(NEW));
      expect(h.setFile).toHaveBeenCalledTimes(1);
      const saved = h.setFile.mock.calls[0][0] as FileState;
      expect(saved.localMtime).toBeUndefined();
      expect(saved.localSize).toBeUndefined();
      expect(saved.localHash).toBe('h0');
      expect('ctimeLocalAttempt' in saved).toBe(false);
    });

    it('stats before the set and again after it', async () => {
      const h = makeHarness({ base: { localMtime: 777, localSize: 11 } });
      await h.aligner.align(h.client, remote(OLD), stOf(NEW));
      expect(h.stat).toHaveBeenCalledTimes(2);
      const [first, second] = h.stat.mock.invocationCallOrder;
      const [set] = h.setLocal.mock.invocationCallOrder;
      expect(first).toBeLessThan(set);
      expect(second).toBeGreaterThan(set);
    });

    it('drops the signature, keeps the hash and clears the attempt when the file changed after the record', async () => {
      // Record (1, 2) differs from the pre-set stat (777, 11): an edit landed after the record was taken.
      const h = makeHarness({ base: { ctimeLocalAttempt: 42, localMtime: 1, localSize: 2, localHash: 'h0' } });
      h.stat.mockResolvedValueOnce(PRE).mockResolvedValueOnce(POST);
      await h.aligner.align(h.client, remote(OLD), stOf(NEW));
      expect(h.setFile).toHaveBeenCalledTimes(1);
      const saved = h.setFile.mock.calls[0][0] as FileState;
      expect(saved.localMtime).toBeUndefined();
      expect(saved.localSize).toBeUndefined();
      expect('ctimeLocalAttempt' in saved).toBe(false);
      expect(saved.localHash).toBe('h0');
    });

    it('drops the signature when the stat before the set reports the file absent', async () => {
      const h = makeHarness({ base: { ctimeLocalAttempt: 42, localMtime: 777, localSize: 11, localHash: 'h0' } });
      h.stat.mockResolvedValueOnce(null).mockResolvedValueOnce(POST);
      await h.aligner.align(h.client, remote(OLD), stOf(NEW));
      expect(h.setFile).toHaveBeenCalledTimes(1);
      const saved = h.setFile.mock.calls[0][0] as FileState;
      expect(saved.localMtime).toBeUndefined();
      expect(saved.localSize).toBeUndefined();
      expect('ctimeLocalAttempt' in saved).toBe(false);
      expect(saved.localHash).toBe('h0');
    });

    it('keeps the record untouched when the unchanged file is absent from the stat after the set', async () => {
      const h = makeHarness({ base: { ctimeLocalAttempt: 42, localMtime: 777, localSize: 11 } });
      h.stat.mockResolvedValueOnce(PRE).mockResolvedValueOnce(null);
      await h.aligner.align(h.client, remote(OLD), stOf(NEW));
      const saved = h.setFile.mock.calls[0][0] as FileState;
      expect(saved.localMtime).toBe(777);
      expect(saved.localSize).toBe(11);
      expect('ctimeLocalAttempt' in saved).toBe(false);
    });

    it('does not stat before the set when the file is being edited', async () => {
      const h = makeHarness({ base: {}, editing: true });
      await h.aligner.align(h.client, remote(OLD), stOf(NEW));
      expect(h.stat).not.toHaveBeenCalled();
    });

    it.each([['ineffective' as const], ['throw' as const]])('%s leaves the recorded signature alone', async (result) => {
      const h = makeHarness({ base: { localMtime: 1, localSize: 2 }, localResult: result });
      await h.aligner.align(h.client, remote(OLD), stOf(NEW));
      const saved = h.setFile.mock.calls[0][0] as FileState;
      expect(saved.localMtime).toBe(1);
      expect(saved.localSize).toBe(2);
      expect(saved.ctimeLocalAttempt).toBe(OLD);
    });
  });

  describe(`${spec('CT-6', 'CT-8')} server update`, () => {
    it.each([
      ['server newer', NEW],
      ['server holds none (0)', 0],
    ])('%s: calls the client with T seconds', async (_n, serverSec) => {
      const h = makeHarness({ base: {} });
      await h.aligner.align(h.client, remote(serverSec), stOf(OLD));
      expect(h.setRemote).toHaveBeenCalledWith(PATH, OLD);
      expect(h.setLocal).not.toHaveBeenCalled();
    });

    it.each([
      ['with', true],
      ['without', false],
    ])('applied %s a base: clears only the remote record', async (_n, hasBase) => {
      const h = makeHarness({ base: hasBase ? { ctimeRemoteAttempt: 9, ctimeLocalAttempt: 8 } : null, remoteResult: 'applied' });
      await h.aligner.align(h.client, remote(NEW), stOf(OLD));
      if (!hasBase) { expect(h.setFile).not.toHaveBeenCalled(); return; }
      const saved = h.setFile.mock.calls[0][0] as FileState;
      expect('ctimeRemoteAttempt' in saved).toBe(false);
      expect(saved.ctimeLocalAttempt).toBe(8);
      expect(saved.localMtime).toBe(1);
    });

    it('rejected with a base records the attempt; without a base writes nothing', async () => {
      const h = makeHarness({ base: {}, remoteResult: 'rejected' });
      await h.aligner.align(h.client, remote(NEW), stOf(OLD));
      expect((h.setFile.mock.calls[0][0] as FileState).ctimeRemoteAttempt).toBe(OLD);
      expect(h.setRootEtag).not.toHaveBeenCalled();
      const n = makeHarness({ base: null, remoteResult: 'rejected' });
      await n.aligner.align(n.client, remote(NEW), stOf(OLD));
      expect(n.setFile).not.toHaveBeenCalled();
    });

    it.each([['with', {}], ['without', null]])('a thrown error %s a base is transient: log, root etag null, nothing recorded', async (_n, base) => {
      const h = makeHarness({ base, remoteResult: 'throw' });
      await expect(h.aligner.align(h.client, remote(NEW), stOf(OLD))).resolves.toBeUndefined();
      expect(h.setFile).not.toHaveBeenCalled();
      expect(h.setRootEtag).toHaveBeenCalledTimes(1);
      expect(h.setRootEtag).toHaveBeenCalledWith(null);
      expect(h.log).toHaveBeenCalled();
      expectLogShape(h);
    });

    it('skips the server update when the record equals T, and retries for another T', async () => {
      const same = makeHarness({ base: { ctimeRemoteAttempt: OLD } });
      await same.aligner.align(same.client, remote(NEW), stOf(OLD));
      expect(same.setRemote).not.toHaveBeenCalled();
      const other = makeHarness({ base: { ctimeRemoteAttempt: OLD + 1 } });
      await other.aligner.align(other.client, remote(NEW), stOf(OLD));
      expect(other.setRemote).toHaveBeenCalledTimes(1);
    });

    it('a read-only local side still updates the server to the older local value', async () => {
      const h = makeHarness({ support: 'readOnly' });
      await h.aligner.align(h.client, remote(0), stOf(OLD));
      expect(h.setRemote).toHaveBeenCalledWith(PATH, OLD);
    });
  });

  describe(`${spec('CT-12')} never rejects`, () => {
    it('resolves when stat, support probe, state and logger all throw', async () => {
      const h = makeHarness();
      h.stat.mockRejectedValue(new Error('x'));
      h.support.mockRejectedValue(new Error('x'));
      h.getFile.mockImplementation(() => { throw new Error('x'); });
      h.log.mockRejectedValue(new Error('x'));
      await expect(h.aligner.align(h.client, remote(OLD))).resolves.toBeUndefined();
      await expect(h.aligner.align(h.client, remote(OLD), stOf(NEW))).resolves.toBeUndefined();
    });

    it('resolves when setFile throws after a successful operation', async () => {
      const h = makeHarness({ base: {} });
      h.setFile.mockImplementation(() => { throw new Error('x'); });
      await expect(h.aligner.align(h.client, remote(NEW), stOf(OLD))).resolves.toBeUndefined();
    });

    it('records outcomes onto the state read after the awaited I/O, not a stale copy', async () => {
      // A concurrent sync updates the same path while the PROPPATCH / local fix is in flight.
      const updated = { path: PATH, localMtime: 99, localSize: 98, remoteEtag: 'new' } as unknown as FileState;
      const remoteCase = makeHarness({ base: {}, remoteResult: 'rejected' });
      remoteCase.setRemote.mockImplementation(async () => {
        remoteCase.getFile.mockReturnValue(updated);
        return 'rejected';
      });
      await remoteCase.aligner.align(remoteCase.client, remote(NEW), stOf(OLD));
      expect(remoteCase.setFile).toHaveBeenCalledWith({ ...updated, ctimeRemoteAttempt: OLD });

      const localCase = makeHarness({ base: {}, localResult: 'ineffective' });
      localCase.setLocal.mockImplementation(async () => {
        localCase.getFile.mockReturnValue(updated);
        return 'ineffective';
      });
      await localCase.aligner.align(localCase.client, remote(OLD), stOf(NEW));
      expect(localCase.setFile).toHaveBeenCalledWith({ ...updated, ctimeLocalAttempt: OLD });
    });

    it('works without a logger', async () => {
      const h = makeHarness({ base: {}, remoteResult: 'throw' });
      const aligner = new CreationTimeAligner({
        localAdapter: { stat: h.stat, setCreationTime: h.setLocal, creationTimeSupport: h.support } as never,
        stateDB: { getFile: h.getFile, setFile: h.setFile, setRemoteRootEtag: h.setRootEtag } as never,
        isBeingEdited: () => false,
      });
      await expect(aligner.align(h.client, remote(NEW), stOf(OLD))).resolves.toBeUndefined();
      expect(h.setRootEtag).toHaveBeenCalledWith(null);
    });
  });
});
