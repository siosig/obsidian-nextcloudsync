// Spec-conformance: 007-conflict-resolution-policy (FINALIZED spec).
// Finalized decisions (per report/recommended_spec.md, accepted):
//  - D2: with autoMerge ON + a mergeable file, reconcile-text always clean-merges;
//    conflictFailurePolicy applies only when autoMerge is OFF or the file is non-mergeable.
//  - D1 (fixed): diverging frontmatter is detected and, under 'conflict' strategy +
//    conflict-markers, full-file markers are written.
import { App } from 'obsidian';
import { DavSyncSettings, DEFAULT_SETTINGS } from '../../src/types';
import { LocalAdapter } from '../../src/data/LocalAdapter';
import { ConflictResolver } from '../../src/sync/ConflictResolver';

function resolver(overrides: Partial<DavSyncSettings>): ConflictResolver {
  const settings: DavSyncSettings = { ...DEFAULT_SETTINGS, deviceId: 'conf-device', ...overrides };
  return new ConflictResolver({} as App, {} as unknown as LocalAdapter, settings);
}

// Same-line BODY conflict (reconcile-text force-merges this without markers).
const BODY = { base: 'shared line\n', local: 'LOCAL edit\n', remote: 'REMOTE edit\n' };
// Diverging FRONTMATTER (diff3 detects this as a real conflict).
const FM = {
  base: '---\ntitle: base\n---\n\nbody\n',
  local: '---\ntitle: local\n---\n\nbody\n',
  remote: '---\ntitle: remote\n---\n\nbody\n',
};

describe('spec 007 — conflict resolution policy (finalized)', () => {
  it('FR-001: mergeability decided by extension, case-insensitive', () => {
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

  it('FR-009: clean (non-overlapping) merge under autoMerge → write clean', () => {
    const r = resolver({ autoMergeEnabled: true, mergeableExtensions: ['md'], conflictFailurePolicy: 'error' });
    const d = r.decide('n.md', 'a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n');
    expect(d.action).toBe('write');
    if (d.action === 'write') expect(d.clean).toBe(true);
  });

  // D2: autoMerge ON + mergeable → reconcile always clean-merges; policy NOT reached.
  it('D2: autoMerge ON + mergeable body conflict → clean write (policy not reached)', () => {
    const r = resolver({ autoMergeEnabled: true, mergeableExtensions: ['md'], conflictFailurePolicy: 'error' });
    const d = r.decide('n.md', BODY.base, BODY.local, BODY.remote);
    expect(d.action).toBe('write');
    if (d.action === 'write') expect(d.clean).toBe(true);
  });

  // FR-005..008: policy is reached when autoMerge is OFF (or non-mergeable).
  it('FR-005: autoMerge OFF + policy=error → skip', () => {
    expect(resolver({ autoMergeEnabled: false, mergeableExtensions: ['md'], conflictFailurePolicy: 'error' })
      .decide('n.md', BODY.base, BODY.local, BODY.remote).action).toBe('skip');
  });

  it('FR-006: autoMerge OFF + policy=local-wins → prefer-local', () => {
    expect(resolver({ autoMergeEnabled: false, mergeableExtensions: ['md'], conflictFailurePolicy: 'local-wins' })
      .decide('n.md', BODY.base, BODY.local, BODY.remote).action).toBe('prefer-local');
  });

  it('FR-007: autoMerge OFF + policy=remote-wins → prefer-remote', () => {
    expect(resolver({ autoMergeEnabled: false, mergeableExtensions: ['md'], conflictFailurePolicy: 'remote-wins' })
      .decide('n.md', BODY.base, BODY.local, BODY.remote).action).toBe('prefer-remote');
  });

  it('FR-008: autoMerge OFF + policy=conflict-markers (mergeable) → write (markers, not clean)', () => {
    const d = resolver({ autoMergeEnabled: false, mergeableExtensions: ['md'], conflictFailurePolicy: 'conflict-markers' })
      .decide('n.md', BODY.base, BODY.local, BODY.remote);
    expect(d.action).toBe('write');
    if (d.action === 'write') expect(d.clean).toBe(false);
  });

  it('FR-003/FR-008(fallback): non-mergeable + conflict-markers → skip (error fallback)', () => {
    expect(resolver({ autoMergeEnabled: true, mergeableExtensions: ['md'], conflictFailurePolicy: 'conflict-markers' })
      .decide('a.pdf', BODY.base, BODY.local, BODY.remote).action).toBe('skip');
  });

  // D1 (fixed): diverging frontmatter under 'conflict' strategy + conflict-markers → markers.
  it('D1: diverging frontmatter + strategy=conflict + conflict-markers → write (markers, not clean)', () => {
    const r = resolver({
      autoMergeEnabled: true, mergeableExtensions: ['md'],
      frontmatterConflictStrategy: 'conflict', conflictFailurePolicy: 'conflict-markers',
    });
    const d = r.decide('n.md', FM.base, FM.local, FM.remote);
    expect(d.action).toBe('write');
    if (d.action === 'write') expect(d.clean).toBe(false);
  });
});
