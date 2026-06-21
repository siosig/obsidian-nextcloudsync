// Spec-conformance: 012-settings-logging-overhaul (pure path/logic FRs).
// 012 supersedes 011 (newer = source of truth). FileLogger/SyncLogWriter level
// gating is covered by existing unit tests; here we assert the log path naming.
import { syncLogPath, debugLogPath, joinLogPath } from '../../src/util/logPaths';
import { shouldRecord, renderSyncLogBlock } from '../../src/log/SyncLogWriter';

describe('spec 012 — per-device logging (paths)', () => {
  it('FR-012 (finalized): sync-log filename uses the .txt extension', () => {
    // Finalized D7: logs are plain text → .txt (avoids Markdown rendering; since 0.4.0).
    expect(syncLogPath('', 'dev1')).toBe('nextcloud-sync_sync_dev1.txt');
  });

  it('FR-020 (finalized): debug-log filename uses the .txt extension', () => {
    expect(debugLogPath('', 'dev1')).toBe('nextcloud-sync_debug_dev1.txt');
  });

  it('FR-008/009: log is placed in the chosen folder; blank ⇒ vault root', () => {
    expect(joinLogPath('_logs', 'x.txt')).toBe('_logs/x.txt');
    expect(joinLogPath('', 'x.txt')).toBe('x.txt');
  });

  it('FR-010: per-device filenames differ by host (no cross-device overwrite)', () => {
    expect(syncLogPath('', 'deviceA')).not.toBe(syncLogPath('', 'deviceB'));
  });

  it('FR-014: "important" level records only conflicts/merges/side-wins/errors', () => {
    expect(shouldRecord('uploaded', 'important')).toBe(false);
    expect(shouldRecord('downloaded', 'important')).toBe(false);
    expect(shouldRecord('conflicted', 'important')).toBe(true);
    expect(shouldRecord('merged', 'important')).toBe(true);
    expect(shouldRecord('local-wins', 'important')).toBe(true);
    expect(shouldRecord('error', 'important')).toBe(true);
  });

  it('FR-014: "all" level records every operation', () => {
    expect(shouldRecord('uploaded', 'all')).toBe(true);
    expect(shouldRecord('deleted', 'all')).toBe(true);
  });

  it('FR-016: a rendered session block carries the binary version header and per-op line', () => {
    const block = renderSyncLogBlock(
      [{ path: 'a.md', op: 'conflicted', at: 0 }],
      { at: 0, version: '9.9.9', resolution: 'r', level: 'important' },
    );
    expect(block).toContain('v9.9.9');
    expect(block).toContain('a.md');
  });

  it('FR-019: nothing is rendered when no entry qualifies at the level', () => {
    const block = renderSyncLogBlock(
      [{ path: 'a.md', op: 'uploaded', at: 0 }],
      { at: 0, version: '9.9.9', resolution: 'r', level: 'important' },
    );
    expect(block).toBe('');
  });
});
