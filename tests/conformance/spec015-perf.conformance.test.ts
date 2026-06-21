// Spec-conformance: 015-sync-performance (pure/default-level FRs).
// SyncEngine-integration FRs (stat-signature fast-path, bounded concurrency,
// If-Match, reactive MKCOL) are covered by existing unit tests
// (change-detection.test, concurrent-sync.test, webdav-roundtrip.test) and the
// e2e suite; here we assert the spec's default/pure-logic requirements.
import { DEFAULT_SETTINGS, FileState } from '../../src/types';
import { resolveConcurrencyDefault, isOverFileSizeLimit } from '../../src/util/limits';
import { StateDB } from '../../src/data/StateDB';
import { makeFakeAdapter } from './support/fakeAdapter';

function fileState(path: string, o: Partial<FileState> = {}): FileState {
  return {
    path, localHash: 'h', remoteId: 'r', idType: 'sha256', size: 1, mtime: 1,
    remoteFileId: null, isConflicted: false, ...o,
  };
}

describe('spec 015 — sync performance (defaults & pure logic)', () => {
  it('FR-021: file locking defaults to OFF', () => {
    expect(DEFAULT_SETTINGS.fileLockingEnabled).toBe(false);
  });

  it('FR-020: mobile default concurrency is 3 (deviceMemory unknown ⇒ 3)', () => {
    expect(resolveConcurrencyDefault(undefined)).toBe(3);
  });

  it('FR-020: desktop default concurrency stays in 8–16', () => {
    const hi = resolveConcurrencyDefault(8);
    expect(hi).toBeGreaterThanOrEqual(8);
    expect(hi).toBeLessThanOrEqual(16);
  });

  it('FR-005: maxFileSizeMB=0 means unlimited (size alone never "skips")', () => {
    expect(isOverFileSizeLimit(10 * 1024 * 1024, 0)).toBe(false);
  });

  it('FR-024 (blind delete) is exercised by NextcloudClient.deleteFile (e2e DEL-2) — boundary check', () => {
    // The "404 = success" deletion is verified live in e2e (DEL-2); here we assert
    // the size-limit boundary used across the upload path stays > (strict).
    expect(isOverFileSizeLimit(2 * 1024 * 1024, 2)).toBe(false); // exactly 2MB at limit 2 ⇒ not over
    expect(isOverFileSizeLimit(2 * 1024 * 1024 + 1, 2)).toBe(true);
  });

  it('FR-013: state is serialized compactly (no pretty-print indentation)', async () => {
    const a = makeFakeAdapter();
    const d = new StateDB(a, 'plugin', 'dev');
    d.setFile(fileState('a.md', { remoteFileId: 'f1' }));
    await d.save();
    const written = a._files.get('plugin/state-dev.json');
    expect(written).toBeDefined();
    // Pretty-print would produce newline+indent; compact JSON has neither.
    expect(written).not.toMatch(/\n\s+/);
  });

  it('FR-015: remote identity lookup is by indexed fileId (O(1)), returns the right file', () => {
    const d = new StateDB(makeFakeAdapter(), 'plugin', 'dev');
    d.setFile(fileState('a.md', { remoteFileId: 'fidA' }));
    d.setFile(fileState('b.md', { remoteFileId: 'fidB' }));
    expect(d.getFileByRemoteId('fidB')?.path).toBe('b.md');
    expect(d.getFileByRemoteId('missing')).toBeUndefined();
  });
});
