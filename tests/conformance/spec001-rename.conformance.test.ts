// Spec-conformance: 001 FR-011 (rename/move tracking via RenameTracker).
// This area had NO existing test — filling the gap with spec-level assertions.
import { StateDB } from '../../src/data/StateDB';
import { RenameTracker } from '../../src/sync/RenameTracker';
import { IWebDAVClient } from '../../src/network/IWebDAVClient';
import { FileState, RemoteFileInfo } from '../../src/types';
import { makeFakeAdapter } from './support/fakeAdapter';

function fileState(path: string, o: Partial<FileState> = {}): FileState {
  return {
    path, localHash: 'h', remoteId: 'r', idType: 'sha256', size: 1, mtime: 1,
    remoteFileId: null, isConflicted: false, ...o,
  };
}
function db(): StateDB { return new StateDB(makeFakeAdapter(), 'plugin', 'dev'); }
const remoteInfo = (path: string, fileId: string): RemoteFileInfo =>
  ({ path, fileId, checksum: null, etag: null, size: 1, lastModified: 1 });

describe('spec 001 — rename tracking (FR-011)', () => {
  it('FR-011: remote rename detected by oc:fileid (old→new), not delete+create', () => {
    const d = db();
    d.setFile(fileState('old.md', { remoteFileId: 'fid1' }));
    const rt = new RenameTracker(d, {} as IWebDAVClient);
    expect(rt.detectRemoteRenames([remoteInfo('new.md', 'fid1')]).get('old.md')).toBe('new.md');
  });

  it('FR-011: local rename detected by hash+size when fileId unavailable', () => {
    const d = db();
    d.setFile(fileState('old.md', { localHash: 'abc', size: 42 }));
    const rt = new RenameTracker(d, {} as IWebDAVClient);
    const added = new Map([['new.md', { hash: 'abc', size: 42 }]]);
    expect(rt.detectLocalRenamesByHash(['old.md'], added).get('old.md')).toBe('new.md');
  });

  it('FR-011: applyRemoteRename moves state old→new preserving fileId', async () => {
    const d = db();
    d.setFile(fileState('old.md', { remoteFileId: 'fid1' }));
    const rt = new RenameTracker(d, {} as IWebDAVClient);
    await rt.applyRemoteRename('old.md', 'new.md');
    expect(d.getFile('old.md')).toBeUndefined();
    expect(d.getFile('new.md')?.remoteFileId).toBe('fid1');
  });

  it('FR-011: applyLocalRename issues a single MOVE and updates state', async () => {
    const d = db();
    d.setFile(fileState('old.md'));
    let moved: [string, string] | null = null;
    const client = { moveFile: async (a: string, b: string) => { moved = [a, b]; } } as unknown as IWebDAVClient;
    const rt = new RenameTracker(d, client);
    await rt.applyLocalRename('old.md', 'new.md');
    expect(moved).toEqual(['old.md', 'new.md']);
    expect(d.getFile('new.md')).toBeDefined();
    expect(d.getFile('old.md')).toBeUndefined();
  });
});
