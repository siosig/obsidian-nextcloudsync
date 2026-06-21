import {
  SyncLogWriter, renderSyncLogBlock, shouldRecord, formatBytes, formatResolution, SyncLogContext,
} from '../../../../src/log/SyncLogWriter';
import { SyncHistoryEntry } from '../../../../src/types';

const ctx: SyncLogContext = {
  at: Date.parse('2026-06-18T00:00:00.000Z'),
  version: '0.2.10',
  resolution: formatResolution({
    failurePolicy: 'error', frontmatterStrategy: 'conflict',
    maxConflictRegions: 0, autoMergeEnabled: true, mergeableExtensions: ['md', 'txt'],
  }),
  level: 'important',
};

function entry(partial: Partial<SyncHistoryEntry> & Pick<SyncHistoryEntry, 'op'>): SyncHistoryEntry {
  return { path: 'note.md', at: ctx.at, ...partial };
}

describe('shouldRecord (level filter)', () => {
  it('important keeps conflicts/merges/side-wins/errors, drops routine ops', () => {
    expect(shouldRecord('conflicted', 'important')).toBe(true);
    expect(shouldRecord('merged', 'important')).toBe(true);
    expect(shouldRecord('local-wins', 'important')).toBe(true);
    expect(shouldRecord('remote-wins', 'important')).toBe(true);
    expect(shouldRecord('error', 'important')).toBe(true);
    expect(shouldRecord('uploaded', 'important')).toBe(false);
    expect(shouldRecord('downloaded', 'important')).toBe(false);
    expect(shouldRecord('deleted', 'important')).toBe(false);
  });

  it('all keeps every operation', () => {
    for (const op of ['uploaded', 'downloaded', 'deleted', 'merged', 'conflicted', 'local-wins', 'remote-wins', 'error'] as const) {
      expect(shouldRecord(op, 'all')).toBe(true);
    }
  });
});

describe('formatBytes', () => {
  it('renders human-readable sizes and a placeholder for unknowns', () => {
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(1536)).toBe('1.5KB');
    expect(formatBytes(undefined)).toBe('-');
  });
});

describe('formatResolution', () => {
  it('reports 0 max regions as unlimited and includes all knobs', () => {
    expect(ctx.resolution).toContain('autoMerge=on');
    expect(ctx.resolution).toContain('failure=error');
    expect(ctx.resolution).toContain('frontmatter=conflict');
    expect(ctx.resolution).toContain('maxRegions=unlimited');
    expect(ctx.resolution).toContain('mergeable=md/txt');
  });
});

describe('renderSyncLogBlock', () => {
  it('returns empty when no entry qualifies at the level', () => {
    const block = renderSyncLogBlock([entry({ op: 'uploaded' })], ctx);
    expect(block).toBe('');
  });

  it('stamps a header with the binary version and conflict-resolution settings', () => {
    const block = renderSyncLogBlock([entry({ op: 'merged' })], ctx);
    expect(block).toContain('## Sync 2026-06-18T00:00:00.000Z');
    expect(block).toContain('v0.2.10');
    expect(block).toContain('maxRegions=unlimited');
  });

  it('formats a per-op line with marker, path, checksums and sizes', () => {
    const block = renderSyncLogBlock([entry({
      op: 'conflicted', path: 'a/b.md',
      localHash: 'abcdef1234567890', localSize: 2048,
      remoteId: '1234567890abcdef', remoteIdType: 'sha256', remoteSize: 4096,
    })], ctx);
    expect(block).toContain('⚠️ `a/b.md`');
    expect(block).toContain('L:abcdef12/2.0KB');
    expect(block).toContain('R:12345678/4.0KB');
  });

  it('annotates the remote id type only when it is not a content hash', () => {
    const etag = renderSyncLogBlock([entry({ op: 'merged', remoteId: 'deadbeefcafe', remoteIdType: 'etag' })], ctx);
    expect(etag).toContain('R:deadbeef(etag)');
    const sha = renderSyncLogBlock([entry({ op: 'merged', remoteId: 'deadbeefcafe', remoteIdType: 'sha256' })], ctx);
    expect(sha).toContain('R:deadbeef/');
    expect(sha).not.toContain('(sha256)');
  });

  it('renders placeholders when checksum/size are unavailable', () => {
    const block = renderSyncLogBlock([entry({ op: 'error' })], ctx);
    expect(block).toContain('L:-/-');
    expect(block).toContain('R:-/-');
  });
});

describe('SyncLogWriter.append', () => {
  function fakeAdapter() {
    const files: Record<string, string> = {};
    return {
      files,
      exists: jest.fn(async (p: string) => p in files),
      append: jest.fn(async (p: string, d: string) => { files[p] = (files[p] ?? '') + d; }),
      write: jest.fn(async (p: string, d: string) => { files[p] = d; }),
    };
  }

  it('does not write when disabled', async () => {
    const a = fakeAdapter();
    const writer = new SyncLogWriter(a as never, () => false, () => 'log.md');
    await writer.append([entry({ op: 'merged' })], ctx);
    expect(a.write).not.toHaveBeenCalled();
    expect(a.append).not.toHaveBeenCalled();
  });

  it('creates the file with a title on first write, then appends', async () => {
    const a = fakeAdapter();
    const writer = new SyncLogWriter(a as never, () => true, () => 'log.md');
    await writer.append([entry({ op: 'merged' })], ctx);
    expect(a.write).toHaveBeenCalledTimes(1);
    expect(a.files['log.md']).toContain('# Nextcloud Sync — sync log');

    await writer.append([entry({ op: 'conflicted' })], ctx);
    expect(a.append).toHaveBeenCalledTimes(1);
    // Original content preserved (append, not truncate).
    expect(a.files['log.md']).toContain('⟷');
    expect(a.files['log.md']).toContain('⚠️');
  });

  it('writes nothing when no entry qualifies', async () => {
    const a = fakeAdapter();
    const writer = new SyncLogWriter(a as never, () => true, () => 'log.md');
    await writer.append([entry({ op: 'uploaded' })], ctx);
    expect(a.write).not.toHaveBeenCalled();
    expect(a.append).not.toHaveBeenCalled();
  });

  it('creates a missing log folder before the first write', async () => {
    // Adapter modelling Obsidian's real constraint: write into a missing folder throws.
    const folders = new Set<string>(['']);
    const files: Record<string, string> = {};
    const a = {
      exists: jest.fn(async (p: string) => folders.has(p) || p in files),
      mkdir: jest.fn(async (p: string) => { folders.add(p); }),
      append: jest.fn(async (p: string, d: string) => { files[p] = (files[p] ?? '') + d; }),
      write: jest.fn(async (p: string, d: string) => {
        const slash = p.lastIndexOf('/');
        const parent = slash > 0 ? p.slice(0, slash) : '';
        if (!folders.has(parent)) throw new Error(`ENOENT: no such folder ${parent}`);
        files[p] = d;
      }),
    };
    const writer = new SyncLogWriter(
      a as never, () => true, () => '_logs/nextcloud-sync_sync_host.txt',
    );
    await writer.append([entry({ op: 'merged' })], ctx);
    expect(a.mkdir).toHaveBeenCalledWith('_logs');
    expect(files['_logs/nextcloud-sync_sync_host.txt']).toContain('# Nextcloud Sync — sync log');
  });
});
