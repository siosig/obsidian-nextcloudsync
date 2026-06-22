// [SPEC:ES-1..ES-10] specs/main/spec.md §8a (root-ETag short-circuit, spec 023).
// Nextcloud propagates child changes up to the vault root ETag, so a matching root ETag means the
// remote tree is unchanged since the last REAL full scan. The full-scan path then rebuilds the remote
// listing from State (skipping getFiles('')∞ / getDirectories('')∞). The rebuilt listing is COMPLETE,
// so it flows through the unchanged full-scan logic (deletion safety, conflicts, uploads untouched).
import { requestUrl, DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { StandardWebDAVClient } from '../../../src/network/StandardWebDAVClient';
import { DEFAULT_SETTINGS, DavSyncSettings, FileState, RemoteFileInfo, RemoteDirInfo } from '../../../src/types';
import { FORCE_FULL_SCAN_EVERY } from '../../../src/util/limits';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

function makeAdapter(files: Record<string, string> = {}): DataAdapter {
  const store = { ...files };
  return {
    read: jest.fn(async (p: string) => store[p] ?? ''),
    write: jest.fn(async (p: string, d: string) => { store[p] = d; }),
    readBinary: jest.fn(), writeBinary: jest.fn(),
    exists: jest.fn(async (p: string) => p in store),
    remove: jest.fn(async (p: string) => { delete store[p]; }),
    rename: jest.fn(async (from: string, to: string) => { store[to] = store[from]; delete store[from]; }),
    stat: jest.fn(), list: jest.fn(),
  } as unknown as DataAdapter;
}

const PLUGIN_DIR = '.obsidian/plugins/obsidian-nextcloudsync';

function fileState(over: Partial<FileState> & Pick<FileState, 'path' | 'remoteId' | 'idType'>): FileState {
  return {
    localHash: 'lh', size: 10, mtime: 100, remoteFileId: `fid-${over.path}`, isConflicted: false,
    remoteMtime: 200, ...over,
  } as FileState;
}

async function makeStateDB(seed?: (db: StateDB) => void): Promise<StateDB> {
  const db = new StateDB(makeAdapter(), PLUGIN_DIR, 'dev-1');
  await db.load();
  seed?.(db);
  return db;
}

interface FakeClient {
  getRootEtag: jest.Mock;
  getFiles: jest.Mock;
  getDirectories: jest.Mock;
}
function fakeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    getRootEtag: jest.fn(async (): Promise<string | null> => null),
    getFiles: jest.fn(async (): Promise<RemoteFileInfo[]> => []),
    getDirectories: jest.fn(async (): Promise<RemoteDirInfo[]> => []),
    ...over,
  };
}

function makeEngine(stateDB: StateDB, isNextcloud: boolean): SyncEngine {
  const engine = new SyncEngine({
    app: {}, settings: { ...DEFAULT_SETTINGS }, localAdapter: {}, stateDB,
    statusBar: {}, webdavFactory: {}, pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);
  (engine as unknown as { features: { isNextcloud: boolean } }).features = { isNextcloud };
  return engine;
}

type Privates = {
  obtainFullScanListing: (c: unknown) => Promise<{ remoteFiles: RemoteFileInfo[]; cachedDirs: RemoteDirInfo[] | null }>;
  rebuildRemoteFilesFromState: () => RemoteFileInfo[];
  rebuildRemoteDirsFromState: () => RemoteDirInfo[];
};
const priv = (e: SyncEngine): Privates => e as unknown as Privates;

describe('[SPEC:ES-1..ES-10] root-ETag short-circuit', () => {
  describe('obtainFullScanListing decision logic', () => {
    it('[SPEC:ES-2][SPEC:ES-10] stored==current root ETag on Nextcloud → SHORT-CIRCUIT: getFiles not called, dirs rebuilt', async () => {
      const db = await makeStateDB((d) => {
        d.setFile(fileState({ path: 'a.md', remoteId: 'h-a', idType: 'sha256' }));
        d.setDir({ path: 'sub', remoteFileId: 'dfid' });
        d.setRemoteRootEtag('ROOT-1');
      });
      const client = fakeClient({ getRootEtag: jest.fn(async () => 'ROOT-1') });
      const engine = makeEngine(db, true);

      const out = await priv(engine).obtainFullScanListing(client);

      expect(client.getRootEtag).toHaveBeenCalledTimes(1);
      expect(client.getFiles).not.toHaveBeenCalled();          // ES-2: ∞ PROPFIND skipped
      expect(out.cachedDirs).not.toBeNull();                   // ES-10: dir listing rebuilt → reconcile skips getDirectories
      expect(out.cachedDirs!.map((d) => d.path)).toEqual(['sub']);
      expect(out.remoteFiles.map((f) => f.path)).toEqual(['a.md']);
      expect(db.getFullScanSkipCount()).toBe(1);               // skip budget consumed
      expect(db.getRemoteRootEtag()).toBe('ROOT-1');           // ES-6: stored etag NOT changed on short-circuit
    });

    it('[SPEC:ES-1][SPEC:ES-5] current != stored → REAL scan: getFiles called, stored etag updated, count reset', async () => {
      const db = await makeStateDB((d) => { d.setRemoteRootEtag('OLD'); d.setFullScanSkipCount(3); });
      const remote: RemoteFileInfo[] = [{ path: 'x.md', fileId: 'f', checksum: 'c', etag: null, size: 1, lastModified: 0 }];
      const client = fakeClient({ getRootEtag: jest.fn(async () => 'NEW'), getFiles: jest.fn(async () => remote) });
      const engine = makeEngine(db, true);

      const out = await priv(engine).obtainFullScanListing(client);

      expect(client.getRootEtag).toHaveBeenCalledTimes(1);     // ES-1: root etag fetched on full-scan path
      expect(client.getFiles).toHaveBeenCalledWith('');        // ES-5: real listing
      expect(out.cachedDirs).toBeNull();
      expect(out.remoteFiles).toBe(remote);
      expect(db.getRemoteRootEtag()).toBe('NEW');              // stored updated to current
      expect(db.getFullScanSkipCount()).toBe(0);              // ES-8 reset
    });

    it('[SPEC:ES-5] getRootEtag returns null (fetch failure) → REAL scan, stored etag set null', async () => {
      const db = await makeStateDB((d) => d.setRemoteRootEtag('OLD'));
      const client = fakeClient({ getRootEtag: jest.fn(async () => null), getFiles: jest.fn(async () => []) });
      const out = await priv(makeEngine(db, true)).obtainFullScanListing(client);
      expect(client.getFiles).toHaveBeenCalledWith('');
      expect(out.cachedDirs).toBeNull();
      expect(db.getRemoteRootEtag()).toBeNull();
    });

    it('[SPEC:ES-7] no stored root etag (first run after upgrade) → REAL scan even if current is present', async () => {
      const db = await makeStateDB(); // remoteRootEtag absent
      const client = fakeClient({ getRootEtag: jest.fn(async () => 'ROOT-1'), getFiles: jest.fn(async () => []) });
      const out = await priv(makeEngine(db, true)).obtainFullScanListing(client);
      expect(client.getFiles).toHaveBeenCalledWith('');
      expect(out.cachedDirs).toBeNull();
      expect(db.getRemoteRootEtag()).toBe('ROOT-1');           // now populated → next sync can short-circuit
    });

    it('[SPEC:ES-7] non-Nextcloud → never short-circuits and never even fetches root etag', async () => {
      const db = await makeStateDB((d) => d.setRemoteRootEtag('ROOT-1'));
      const client = fakeClient({ getRootEtag: jest.fn(async () => 'ROOT-1'), getFiles: jest.fn(async () => []) });
      const out = await priv(makeEngine(db, false)).obtainFullScanListing(client);
      expect(client.getRootEtag).not.toHaveBeenCalled();       // isNextcloud=false short-circuits the check
      expect(client.getFiles).toHaveBeenCalledWith('');
      expect(out.cachedDirs).toBeNull();
      expect(db.getRemoteRootEtag()).toBeNull();               // stored cur=null on non-NC
    });

    it('[SPEC:ES-8] skip budget reached → FORCED real scan despite matching etag, then count resets', async () => {
      const db = await makeStateDB((d) => { d.setRemoteRootEtag('ROOT-1'); d.setFullScanSkipCount(FORCE_FULL_SCAN_EVERY); });
      const client = fakeClient({ getRootEtag: jest.fn(async () => 'ROOT-1'), getFiles: jest.fn(async () => []) });
      const out = await priv(makeEngine(db, true)).obtainFullScanListing(client);
      expect(client.getFiles).toHaveBeenCalledWith('');        // forced real scan even though cur===stored
      expect(out.cachedDirs).toBeNull();
      expect(db.getFullScanSkipCount()).toBe(0);
    });

    it('[SPEC:ES-6] self-heal: a local upload changes the remote root etag → next sync real-scans', async () => {
      const db = await makeStateDB((d) => { d.setFile(fileState({ path: 'a.md', remoteId: 'h', idType: 'sha256' })); d.setRemoteRootEtag('ROOT-1'); });
      // Sync 1: unchanged → short-circuit (stored stays ROOT-1).
      const c1 = fakeClient({ getRootEtag: jest.fn(async () => 'ROOT-1') });
      await priv(makeEngine(db, true)).obtainFullScanListing(c1);
      expect(c1.getFiles).not.toHaveBeenCalled();
      expect(db.getRemoteRootEtag()).toBe('ROOT-1');
      // Sync 2: an upload has since changed the remote → root etag differs → real scan.
      const c2 = fakeClient({ getRootEtag: jest.fn(async () => 'ROOT-2'), getFiles: jest.fn(async () => []) });
      await priv(makeEngine(db, true)).obtainFullScanListing(c2);
      expect(c2.getFiles).toHaveBeenCalledWith('');
      expect(db.getRemoteRootEtag()).toBe('ROOT-2');
    });
  });

  describe('[SPEC:ES-4][SPEC:ES-3] rebuilt remote listing', () => {
    it('[SPEC:ES-4] reconstructs checksum/etag/size by idType so every file reads as remote-unchanged', async () => {
      const db = await makeStateDB((d) => {
        d.setFile(fileState({ path: 'sha.md', remoteId: 'deadbeef', idType: 'sha256' }));
        d.setFile(fileState({ path: 'etag.md', remoteId: 'W/"v1"', idType: 'etag' }));
        d.setFile(fileState({ path: 'size.md', remoteId: '42', idType: 'size', size: 42 }));
      });
      const files = priv(makeEngine(db, true)).rebuildRemoteFilesFromState();
      const by = (p: string): RemoteFileInfo => files.find((f) => f.path === p)!;
      // effective id used by processRemoteFile = checksum ?? etag ?? String(size); must equal base.remoteId.
      expect(by('sha.md').checksum).toBe('deadbeef');
      expect(by('sha.md').etag).toBeNull();
      expect(by('etag.md').etag).toBe('W/"v1"');
      expect(by('etag.md').checksum).toBeNull();
      expect(by('size.md').checksum).toBeNull();
      expect(by('size.md').etag).toBeNull();
      expect(String(by('size.md').size)).toBe('42');
    });

    it('[SPEC:ES-3] rebuilt listing is COMPLETE (one entry per tracked file/dir) so absence-based deletion safety still applies', async () => {
      const db = await makeStateDB((d) => {
        d.setFile(fileState({ path: 'a.md', remoteId: 'h1', idType: 'sha256' }));
        d.setFile(fileState({ path: 'b/c.md', remoteId: 'h2', idType: 'sha256' }));
        d.setDir({ path: 'b', remoteFileId: 'dfid' });
      });
      const engine = makeEngine(db, true);
      expect(priv(engine).rebuildRemoteFilesFromState().map((f) => f.path).sort()).toEqual(['a.md', 'b/c.md']);
      expect(priv(engine).rebuildRemoteDirsFromState().map((d) => d.path)).toEqual(['b']);
    });
  });

  describe('[SPEC:ES-9] StateDB persistence & back-compat', () => {
    it('round-trips remoteRootEtag and fullScanSkipCount through save/load', async () => {
      const adapter = makeAdapter();
      const db = new StateDB(adapter, PLUGIN_DIR, 'dev-1');
      await db.load();
      db.setRemoteRootEtag('ROOT-9');
      db.setFullScanSkipCount(7);
      await db.save();
      const reopened = new StateDB(adapter, PLUGIN_DIR, 'dev-1');
      await reopened.load();
      expect(reopened.getRemoteRootEtag()).toBe('ROOT-9');
      expect(reopened.getFullScanSkipCount()).toBe(7);
    });

    it('a pre-023 state file (no fields) loads with remoteRootEtag=null and skipCount=0', async () => {
      const old = JSON.stringify({ deviceId: 'dev-1', lastSyncTime: 1, syncToken: null, files: {}, directories: {} });
      const adapter = makeAdapter({ [`${PLUGIN_DIR}/state-dev-1.json`]: old });
      const db = new StateDB(adapter, PLUGIN_DIR, 'dev-1');
      await db.load();
      expect(db.getRemoteRootEtag()).toBeNull();   // absent ⇒ real full scan next time
      expect(db.getFullScanSkipCount()).toBe(0);
    });
  });

  describe('client getRootEtag contract', () => {
    const settings: DavSyncSettings = { ...DEFAULT_SETTINGS, serverUrl: 'https://nc/remote.php/dav/files/alice/', username: 'alice', deviceId: 'dev-1234' };
    // NextcloudClient parses the PROPFIND XML with `new DOMParser()`. The a-layer `node` env has none
    // (only b1 polyfills it), so provide it from @xmldom/xmldom for the parsing assertions here.
    let prevDOMParser: unknown;
    beforeAll(() => {
      prevDOMParser = (globalThis as unknown as { DOMParser?: unknown }).DOMParser;
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- test-only polyfill
      (globalThis as unknown as { DOMParser: unknown }).DOMParser = require('@xmldom/xmldom').DOMParser;
    });
    afterAll(() => { (globalThis as unknown as { DOMParser: unknown }).DOMParser = prevDOMParser; });
    beforeEach(() => mockRequestUrl.mockReset());

    it('NextcloudClient.getRootEtag returns the root getetag on 207 (quotes stripped)', async () => {
      mockRequestUrl.mockResolvedValueOnce({
        status: 207, json: {}, arrayBuffer: new ArrayBuffer(0), headers: {},
        text: '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x/</d:href><d:propstat><d:prop><d:getetag>"abc123"</d:getetag></d:prop></d:propstat></d:response></d:multistatus>',
      });
      const etag = await new NextcloudClient(settings, 'pw', 'Vault').getRootEtag();
      expect(etag).toBe('abc123');
      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.method).toBe('PROPFIND');
      expect(call.headers.Depth).toBe('0');
    });

    it('NextcloudClient.getRootEtag returns null on 404 (folder not created yet)', async () => {
      mockRequestUrl.mockResolvedValueOnce({ status: 404, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });
      expect(await new NextcloudClient(settings, 'pw', 'Vault').getRootEtag()).toBeNull();
    });

    it('NextcloudClient.getRootEtag returns null when the request throws (never propagates)', async () => {
      mockRequestUrl.mockRejectedValueOnce(new Error('network down'));
      expect(await new NextcloudClient(settings, 'pw', 'Vault').getRootEtag()).toBeNull();
    });

    it('NextcloudClient.getRootEtag returns null on 207 without a getetag', async () => {
      mockRequestUrl.mockResolvedValueOnce({
        status: 207, json: {}, arrayBuffer: new ArrayBuffer(0), headers: {},
        text: '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x/</d:href><d:propstat><d:prop></d:prop></d:propstat></d:response></d:multistatus>',
      });
      expect(await new NextcloudClient(settings, 'pw', 'Vault').getRootEtag()).toBeNull();
    });

    it('StandardWebDAVClient.getRootEtag returns null without any network call', async () => {
      const etag = await new StandardWebDAVClient(settings, 'pw', 'Vault').getRootEtag();
      expect(etag).toBeNull();
      expect(mockRequestUrl).not.toHaveBeenCalled();
    });
  });
});
