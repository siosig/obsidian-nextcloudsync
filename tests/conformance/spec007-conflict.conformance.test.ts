// Spec-conformance: 007-conflict-resolution-policy (also 001 FR-008/009).
// Asserts the SPEC's expected behavior. A FAIL = implementation deviates.
// See report/spec_conformance.md. DEVIATION comments mark known gaps.
import { App } from 'obsidian';
import { DavSyncSettings, DEFAULT_SETTINGS } from '../../src/types';
import { LocalAdapter } from '../../src/data/LocalAdapter';
import { ConflictResolver } from '../../src/sync/ConflictResolver';

function resolver(overrides: Partial<DavSyncSettings>): ConflictResolver {
  const settings: DavSyncSettings = { ...DEFAULT_SETTINGS, deviceId: 'conf-device', ...overrides };
  return new ConflictResolver({} as App, {} as unknown as LocalAdapter, settings);
}

// A genuine conflict: both sides changed the SAME line. Per the spec this cannot
// be cleanly auto-merged, so the conflictFailurePolicy must apply.
const CONFLICT = { base: 'shared line\n', local: 'LOCAL edit\n', remote: 'REMOTE edit\n' };

describe('spec 007 — conflict resolution policy', () => {
  // ---- Requirements expected to be SATISFIED ----

  it('FR-001: mergeability is decided by extension, case-insensitive', () => {
    const r = resolver({ mergeableExtensions: ['md'] });
    expect(r.isMergeable('Note.MD')).toBe(true);
    expect(r.isMergeable('a.PDF')).toBe(false);
  });

  it('FR-002: default mergeable extensions are md and txt', () => {
    expect(DEFAULT_SETTINGS.mergeableExtensions).toEqual(['md', 'txt']);
  });

  it('FR-004: default conflictFailurePolicy is error', () => {
    expect(DEFAULT_SETTINGS.conflictFailurePolicy).toBe('error');
  });

  it('FR-003/FR-008(fallback): non-mergeable + conflict-markers → skip (error fallback)', () => {
    const r = resolver({ autoMergeEnabled: true, mergeableExtensions: ['md'], conflictFailurePolicy: 'conflict-markers' });
    expect(r.decide('a.pdf', CONFLICT.base, CONFLICT.local, CONFLICT.remote).action).toBe('skip');
  });

  it('FR-009: clean (non-overlapping) merge under autoMerge → write clean', () => {
    const r = resolver({ autoMergeEnabled: true, mergeableExtensions: ['md'], conflictFailurePolicy: 'error' });
    const d = r.decide('n.md', 'a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n');
    expect(d.action).toBe('write');
    if (d.action === 'write') expect(d.clean).toBe(true);
  });

  // ---- Requirements where the implementation is expected to DEVIATE ----

  it('FR-005: genuine conflict + policy=error → skip, both sides untouched', () => {
    // DEVIATION (F5): ReconcileTextStrategy force-merges (never reports a conflict),
    // so autoMerge ON yields a clean write instead of reaching policy=error → skip.
    const r = resolver({ autoMergeEnabled: true, mergeableExtensions: ['md'], conflictFailurePolicy: 'error' });
    expect(r.decide('n.md', CONFLICT.base, CONFLICT.local, CONFLICT.remote).action).toBe('skip');
  });

  it('FR-006: genuine conflict + policy=local-wins → prefer-local', () => {
    // DEVIATION (F5): autoMerge ON + mergeable never reaches policy → clean write.
    const r = resolver({ autoMergeEnabled: true, mergeableExtensions: ['md'], conflictFailurePolicy: 'local-wins' });
    expect(r.decide('n.md', CONFLICT.base, CONFLICT.local, CONFLICT.remote).action).toBe('prefer-local');
  });

  it('FR-007: genuine conflict + policy=remote-wins → prefer-remote', () => {
    // DEVIATION (F5): same as above.
    const r = resolver({ autoMergeEnabled: true, mergeableExtensions: ['md'], conflictFailurePolicy: 'remote-wins' });
    expect(r.decide('n.md', CONFLICT.base, CONFLICT.local, CONFLICT.remote).action).toBe('prefer-remote');
  });

  it('FR-008: genuine conflict (mergeable) + policy=conflict-markers → markers written (not clean)', () => {
    // DEVIATION (F5): force-merge yields a clean write, no markers.
    const r = resolver({ autoMergeEnabled: true, mergeableExtensions: ['md'], conflictFailurePolicy: 'conflict-markers' });
    const d = r.decide('n.md', CONFLICT.base, CONFLICT.local, CONFLICT.remote);
    expect(d.action).toBe('write');
    if (d.action === 'write') expect(d.clean).toBe(false);
  });

  it('001 FR-009 / 007 FR-008: diverging frontmatter + conflict-markers → full-file markers', () => {
    // DEVIATION (F4): Diff3Strategy mis-reads node-diff3 merge() output, so diverging
    // frontmatter is counted as conflictRegions:0 and silently merged (no markers).
    const r = resolver({
      autoMergeEnabled: true, mergeableExtensions: ['md'],
      frontmatterConflictStrategy: 'conflict', conflictFailurePolicy: 'conflict-markers',
    });
    const d = r.decide('n.md', '---\ntitle: base\n---\n\nbody\n', '---\ntitle: local\n---\n\nbody\n', '---\ntitle: remote\n---\n\nbody\n');
    expect(d.action).toBe('write');
    if (d.action === 'write') expect(d.clean).toBe(false);
  });
});
