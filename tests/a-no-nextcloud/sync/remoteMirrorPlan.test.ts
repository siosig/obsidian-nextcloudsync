import { buildMirrorPlan, LocalFileEntry } from '../../../src/sync/mirrorPlan';
import { RemoteFileInfo } from '../../../src/types';

// [SPEC:MIR-1] specs/045-remote-mirror-pull — Pull mirror plan classification (pure).
// The mirror overwrites this device to match the remote: download what the remote has (or differs),
// delete local-only files/folders, skip content-identical files. It bypasses the mass-delete breaker
// COUNT limit but is gated on a COMPLETE remote listing (FR-008/FR-009). Folders deleted child→parent
// (FR-016). Exclusions honored (FR-010).

function remote(path: string, checksum: string | null = null): RemoteFileInfo {
  return { path, fileId: null, checksum, etag: null, size: 1, lastModified: 0 };
}
function local(path: string, hash: string): LocalFileEntry {
  return { path, hash };
}
const noExclude = () => false;

describe('[SPEC:MIR-1] buildMirrorPlan', () => {
  describe('download / skip classification', () => {
    it('downloads remote files missing locally', () => {
      const plan = buildMirrorPlan([remote('a.md'), remote('b.md')], [], [], noExclude, true);
      expect(plan.ok).toBe(true);
      expect(plan.downloads.map((d) => d.path)).toEqual(['a.md', 'b.md']);
      expect(plan.skipCount).toBe(0);
    });

    it('skips remote files whose server checksum equals the local hash', () => {
      const plan = buildMirrorPlan(
        [remote('a.md', 'h-a')],
        [local('a.md', 'h-a')],
        [],
        noExclude,
        true,
      );
      expect(plan.downloads).toHaveLength(0);
      expect(plan.skipCount).toBe(1);
    });

    it('downloads (overwrites) when local hash differs from the remote checksum', () => {
      const plan = buildMirrorPlan(
        [remote('a.md', 'h-remote')],
        [local('a.md', 'h-local')],
        [],
        noExclude,
        true,
      );
      expect(plan.downloads.map((d) => d.path)).toEqual(['a.md']);
      expect(plan.skipCount).toBe(0);
    });

    it('downloads (safe side) when the remote checksum is unknown even if a local file exists', () => {
      const plan = buildMirrorPlan(
        [remote('a.md', null)],
        [local('a.md', 'h-local')],
        [],
        noExclude,
        true,
      );
      expect(plan.downloads.map((d) => d.path)).toEqual(['a.md']);
      expect(plan.skipCount).toBe(0);
    });
  });

  describe('local-only deletion', () => {
    it('deletes local files absent from the remote listing', () => {
      const plan = buildMirrorPlan(
        [remote('keep.md', 'h')],
        [local('keep.md', 'h'), local('gone1.md', 'x'), local('gone2.md', 'y')],
        [],
        noExclude,
        true,
      );
      expect(plan.deleteFiles.sort()).toEqual(['gone1.md', 'gone2.md']);
    });

    it('deletes local-only folders sorted child→parent (deepest first)', () => {
      const plan = buildMirrorPlan(
        [remote('kept/a.md')],
        [],
        ['old', 'old/deep', 'old/deep/deeper', 'kept'],
        noExclude,
        true,
      );
      // 'kept' has a remote file under it → kept. The 'old' tree is local-only → deleted, deepest first.
      expect(plan.deleteDirs).toEqual(['old/deep/deeper', 'old/deep', 'old']);
    });

    it('keeps a folder that still holds a remote file', () => {
      const plan = buildMirrorPlan(
        [remote('dir/file.md')],
        [],
        ['dir'],
        noExclude,
        true,
      );
      expect(plan.deleteDirs).toEqual([]);
    });
  });

  describe('exclusions (FR-010)', () => {
    it('never downloads or deletes excluded paths', () => {
      // Realistic folder-boundary predicate: the folder itself and everything under it are excluded.
      const isExcluded = (p: string) =>
        p === '.obsidian' || p.startsWith('.obsidian/') || p === 'Excluded' || p.startsWith('Excluded/');
      const plan = buildMirrorPlan(
        [remote('.obsidian/x.json', 'h'), remote('note.md', 'h2')],
        [local('Excluded/keep.md', 'z'), local('note.md', 'old')],
        ['Excluded', 'Excluded/sub'],
        isExcluded,
        true,
      );
      // excluded remote not downloaded; excluded local not deleted; excluded dirs not deleted
      expect(plan.downloads.map((d) => d.path)).toEqual(['note.md']);
      expect(plan.deleteFiles).toEqual([]);
      expect(plan.deleteDirs).toEqual([]);
    });
  });

  describe('[SPEC:MIR-2] listing-completeness gate (FR-009 / SC-005)', () => {
    it('when the listing is not ok, plan is not ok and every list is empty (zero deletions)', () => {
      const plan = buildMirrorPlan(
        [],
        [local('a.md', 'x'), local('b.md', 'y')],
        ['dir'],
        noExclude,
        false,
        'network error',
      );
      expect(plan.ok).toBe(false);
      expect(plan.reason).toContain('network error');
      expect(plan.downloads).toHaveLength(0);
      expect(plan.deleteFiles).toHaveLength(0);
      expect(plan.deleteDirs).toHaveLength(0);
      expect(plan.skipCount).toBe(0);
    });
  });

  describe('counts for the confirmation dialog (FR-003)', () => {
    it('reports download count and total delete count', () => {
      const plan = buildMirrorPlan(
        [remote('new.md'), remote('same.md', 'h'), remote('diff.md', 'hr')],
        [local('same.md', 'h'), local('diff.md', 'hl'), local('goneFile.md', 'g')],
        ['goneDir'],
        noExclude,
        true,
      );
      expect(plan.downloads.map((d) => d.path).sort()).toEqual(['diff.md', 'new.md']);
      expect(plan.skipCount).toBe(1); // same.md
      const deleteTotal = plan.deleteFiles.length + plan.deleteDirs.length;
      expect(deleteTotal).toBe(2); // goneFile.md + goneDir
    });
  });
});
