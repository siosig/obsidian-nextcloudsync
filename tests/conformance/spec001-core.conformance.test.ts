// Spec-conformance: 001-nextcloudsync-plugin (core requirements).
// Asserts the SPEC's expected behavior. A FAIL = implementation deviates.
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DavSyncSettings, DEFAULT_SETTINGS } from '../../src/types';
import { ConflictResolver } from '../../src/sync/ConflictResolver';
import { MergeEngine } from '../../src/sync/merge/MergeEngine';
import type { App } from 'obsidian';
import type { LocalAdapter } from '../../src/data/LocalAdapter';

function resolver(overrides: Partial<DavSyncSettings>): ConflictResolver {
  return new ConflictResolver({} as App, {} as unknown as LocalAdapter, { ...DEFAULT_SETTINGS, deviceId: 'conf-device', ...overrides });
}

describe('spec 001 — core requirements', () => {
  // ---- Expected to be SATISFIED ----

  it('FR-019: credentials are referenced by secret id, not stored as plaintext password', () => {
    expect(DEFAULT_SETTINGS).toHaveProperty('passwordSecretId');
    expect(DEFAULT_SETTINGS).not.toHaveProperty('password');
    expect(DEFAULT_SETTINGS).not.toHaveProperty('appPassword');
  });

  it('FR-020: minimum Obsidian version is 1.12.7', () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'manifest.json'), 'utf-8')) as { minAppVersion: string };
    expect(manifest.minAppVersion).toBe('1.12.7');
  });

  it('FR-008: a conflict preserves BOTH sides (conflict-markers keep local and remote)', () => {
    // With markers, both the local and remote text must survive in the written content.
    const r = resolver({ autoMergeEnabled: false, mergeableExtensions: ['md'], conflictFailurePolicy: 'conflict-markers' });
    const d = r.decide('n.md', 'base\n', 'LOCAL-ONLY\n', 'REMOTE-ONLY\n');
    expect(d.action).toBe('write');
    if (d.action === 'write') {
      expect(d.content).toContain('LOCAL-ONLY');
      expect(d.content).toContain('REMOTE-ONLY');
    }
  });

  // ---- Expected to DEVIATE (spec is older than the implementation here) ----

  it('FR-013: auto-merge defaults to OFF', () => {
    // DEVIATION: implementation ships autoMergeEnabled: true (README also says "on by default").
    // Decision needed: update the spec (implementation-as-truth) or flip the default.
    expect(DEFAULT_SETTINGS.autoMergeEnabled).toBe(false);
  });

  it('FR-010: YAML frontmatter is excluded from auto-merge', () => {
    // SPEC 001 FR-010 says frontmatter must NOT be auto-merged.
    // DEVIATION: MergeEngine merges frontmatter via diff3 (README: "frontmatter auto-merged").
    // If frontmatter were excluded, diverging frontmatter (bodies identical) would NOT
    // come back as a clean, conflict-free success.
    const engine = new MergeEngine({ maxConflictRegions: 0, frontmatterConflictStrategy: 'conflict' });
    const r = engine.merge('---\nk: base\n---\nbody\n', '---\nk: local\n---\nbody\n', '---\nk: remote\n---\nbody\n');
    expect(r.success && !r.hadConflicts).toBe(false);
  });
});
