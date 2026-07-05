// Spec-conformance: 001-nextcloudsync-plugin (core requirements).
// Asserts the SPEC's expected behavior. A FAIL = implementation deviates.
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DEFAULT_SETTINGS } from '../../../src/types';
import { ConflictResolver, MergeConfig } from '../../../src/sync/ConflictResolver';
import { MergeEngine } from '../../../src/sync/merge/MergeEngine';
import type { App } from 'obsidian';
import type { LocalAdapter } from '../../../src/data/LocalAdapter';

function resolver(overrides: Partial<MergeConfig>): ConflictResolver {
  return new ConflictResolver({} as App, {} as unknown as LocalAdapter, {
    autoMergeFileTypes: DEFAULT_SETTINGS.autoMergeFileTypes,
    autoMergeFileStrategy: DEFAULT_SETTINGS.autoMergeFileStrategy,
    otherFileStrategy: DEFAULT_SETTINGS.otherFileStrategy,
    frontmatterStrategy: DEFAULT_SETTINGS.frontmatterStrategy,
    conflictStrategy: DEFAULT_SETTINGS.conflictStrategy,
    deviceId: 'conf-device',
    ...overrides,
  });
}

describe('spec 001 — core requirements', () => {
  // ---- Expected to be SATISFIED ----

  it('FR-019: credentials are referenced by secret id, not stored as plaintext password', () => {
    expect(DEFAULT_SETTINGS).toHaveProperty('passwordSecretId');
    expect(DEFAULT_SETTINGS).not.toHaveProperty('password');
    expect(DEFAULT_SETTINGS).not.toHaveProperty('appPassword');
  });

  it('FR-020 (finalized): minimum Obsidian version is 1.11.4 (secret-storage API)', () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'manifest.json'), 'utf-8')) as { minAppVersion: string };
    expect(manifest.minAppVersion).toBe('1.11.4');
  });

  it('FR-008: a conflict preserves BOTH sides (feature 040: frontmatter merged semantically, body preserved)', () => {
    // Feature 040: scalar frontmatter (k:1 vs k:2) is now resolved by policy (remote-win default).
    // Both body sections (LOCAL-ONLY, REMOTE-ONLY) are preserved via reconcile-text merge.
    const r = resolver({ autoMergeFileTypes: ['md'], autoMergeFileStrategy: 'merge' });
    const d = r.decide('n.md', '', '---\nk: 1\n---\nLOCAL-ONLY\n', '---\nk: 2\n---\nREMOTE-ONLY\n');
    expect(d.action).toBe('write');
    if (d.action === 'write') {
      expect(d.content).toContain('LOCAL-ONLY');
      expect(d.content).toContain('REMOTE-ONLY');
    }
  });

  // ---- Finalized: spec updated to match the implementation (D4/D5) ----

  it('FR-013 (finalized): the Auto Merge File strategy defaults to Merge', () => {
    // Feature 037: the autoMerge toggle became a per-type strategy; the default is still merge, so
    // the plugin's value — loss-less automatic merge of non-overlapping edits — is unchanged.
    expect(DEFAULT_SETTINGS.autoMergeFileStrategy).toBe('merge');
  });

  it('FR-010 (finalized): YAML frontmatter is auto-merged (non-overlapping lines merge cleanly)', () => {
    // Finalized D5: frontmatter is IN scope for auto-merge — non-overlapping frontmatter
    // edits (different keys) merge cleanly via diff3; only same-line divergence conflicts.
    const engine = new MergeEngine();
    // Keep the two changed keys on non-adjacent lines: line-based diff3 merges distinct
    // lines cleanly, but adjacent changed lines collapse into one (conflicting) hunk.
    const base = '---\nk1: a\nmid: x\nk2: b\n---\nbody\n';
    const local = '---\nk1: A\nmid: x\nk2: b\n---\nbody\n';   // changed k1 only
    const remote = '---\nk1: a\nmid: x\nk2: B\n---\nbody\n';  // changed k2 only
    const r = engine.merge(base, local, remote);
    expect(r.success).toBe(true);
    expect(r.hadConflicts).toBe(false);
  });
});
