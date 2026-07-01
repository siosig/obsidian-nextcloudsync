import { App } from 'obsidian';
import { ConflictResolution, FrontmatterScalarPolicy, MergeContext, SyncStrategy } from '../types';
import { LocalAdapter } from '../data/LocalAdapter';
import { MergeEngine } from './merge/MergeEngine';
import { FIXED } from '../util/fixedSyncConfig';
import { isAutoMergeFileType } from '../util/mergeableExtensions';

const CONFLICT_TAG = '#conflict';
const CONFLICT_MARKER_RE = /^<<<<<<< /m;

/**
 * Feature 039 (FR-039-4): detect THIS plugin's OWN conflict markers — the start line written by
 * `buildMarkerContent` / Diff3Strategy (`<<<<<<< LOCAL …`) or its closing line (`>>>>>>> REMOTE …`).
 * Stricter than CONFLICT_MARKER_RE (`^<<<<<<< `, which matches any `<<<<<<< whatever`): a user may
 * legitimately write a bare `<<<<<<< HEAD` in a note, and that must NOT trip the re-entrancy guard.
 */
const REENTRANT_MARKER_RE = /^(?:<<<<<<< LOCAL|>>>>>>> REMOTE)/m;

/**
 * Conflict-resolution parameters the ConflictResolver needs (feature 037). The three former conflict
 * settings (autoMergeEnabled / conflictFailurePolicy / frontmatterConflictStrategy) collapsed into a
 * single per-type strategy: a file is classified as an Auto Merge File (its extension is in
 * `autoMergeFileTypes`) or Other File, and the matching strategy is applied. These are an explicit
 * input (not read from settings inside the resolver) so the class stays pure and every branch is
 * independently unit-testable: internal branching is not user freedom.
 */
export interface MergeConfig {
  autoMergeFileTypes: string[];
  autoMergeFileStrategy: SyncStrategy;
  otherFileStrategy: Exclude<SyncStrategy, 'merge'>;
  /** Device id, used for the conflict-marker byline. */
  deviceId: string;
  /** Scalar frontmatter conflict resolution policy (feature 040, Experimental). Defaults to 'latest-mtime' when absent. */
  frontmatterScalarPolicy?: FrontmatterScalarPolicy;
}

/**
 * Size/mtime of both sides, needed by the deterministic biggest-size / latest-mtime strategies
 * (FR-006/FR-007). Passed in by SyncEngine (which has the local stat and the RemoteFileInfo) so the
 * resolver stays pure — it performs no I/O. Absent only for merge / local-win / remote-win callers.
 */
export interface ConflictContext {
  localSize: number;
  remoteSize: number;
  localMtime: number;
  remoteMtime: number;
}

/**
 * A decoded string is "non-text" when it carries a NUL byte (the standard binary signal git uses;
 * real text never contains U+0000) or a U+FFFD replacement char (invalid UTF-8 replaced at decode).
 * Used to keep the `merge` strategy from writing conflict markers into binary files (FR-005a).
 */
export function isLikelyBinary(s: string): boolean {
  return s.includes('\u0000') || s.includes('\uFFFD');
}

export class ConflictResolver {
  private readonly mergeEngine: MergeEngine;

  constructor(
    private readonly app: App,
    private readonly localAdapter: LocalAdapter,
    private readonly config: MergeConfig,
  ) {
    // maxConflictRegions is a fixed value (feature 033, always unlimited); a clean merge is never
    // downgraded to inline markers on region count alone — the expansion guard (FR-005b) handles the
    // real failure mode (reconcile bloat on an empty base).
    this.mergeEngine = new MergeEngine({ maxConflictRegions: FIXED.maxConflictRegions });
  }

  /**
   * True when `path`'s extension is configured as an Auto Merge File type (case-insensitive).
   * Files without an extension, or whose extension is not in `autoMergeFileTypes`, are Other Files.
   */
  isAutoMergeFile(path: string): boolean {
    return isAutoMergeFileType(path, this.config.autoMergeFileTypes);
  }

  /** The SyncStrategy that applies to `path` after Auto Merge File / Other File classification (CSF-1). */
  strategyFor(path: string): SyncStrategy {
    return this.isAutoMergeFile(path) ? this.config.autoMergeFileStrategy : this.config.otherFileStrategy;
  }

  /**
   * Decide what to do with a conflicting file. PURE: performs no disk or network I/O.
   * SyncEngine.handleConflict executes the corresponding operations for the returned action.
   *
   * Classify by extension → apply the type's SyncStrategy:
   *   merge        → 3-way: clean → write{clean}, text conflict → write markers, non-text → safe-hold
   *   biggest-size → larger side prefer (equal → no-op), needs `ctx`
   *   latest-mtime → newer side prefer  (equal → no-op), needs `ctx`
   *   local-win / remote-win → prefer-local / prefer-remote
   */
  decide(
    path: string, base: string, local: string, remote: string, ctx?: ConflictContext,
  ): ConflictResolution {
    switch (this.strategyFor(path)) {
      case 'merge':
        return this.decideMerge(base, local, remote, ctx);
      case 'local-win':
        return { action: 'prefer-local' };
      case 'remote-win':
        return { action: 'prefer-remote' };
      case 'biggest-size':
        return this.decideByComparison(ctx?.localSize, ctx?.remoteSize);
      case 'latest-mtime':
        return this.decideByComparison(ctx?.localMtime, ctx?.remoteMtime);
    }
  }

  /** merge strategy: 3-way merge with binary safe-hold (FR-005a) and conflict markers for text. */
  private decideMerge(base: string, local: string, remote: string, ctx?: ConflictContext): ConflictResolution {
    // Non-text content cannot carry conflict markers without corruption → leave both sides, flag
    // conflicted, write nothing (FR-005a). The merge engine is text-only.
    if (isLikelyBinary(local) || isLikelyBinary(remote)) {
      return { action: 'safe-hold' };
    }
    // Feature 039 (FR-039-1/2, R2): if EITHER side already carries this plugin's conflict markers,
    // merging would re-wrap the existing markers in NEW markers and duplicate shared blocks — the
    // geometric re-entrancy loop that corrupted real files. Do NOT merge: safe-hold (both untouched,
    // flagged conflicted, nothing pushed) until the user resolves by removing the markers. Self-healing:
    // once the markers are gone the inputs are clean again and the normal merge below resumes.
    if (REENTRANT_MARKER_RE.test(local) || REENTRANT_MARKER_RE.test(remote)) {
      return { action: 'safe-hold' };
    }
    const mergeCtx: MergeContext | undefined = ctx
      ? {
          frontmatterScalarPolicy: this.config.frontmatterScalarPolicy ?? 'latest-mtime',
          localMtime: ctx.localMtime,
          remoteMtime: ctx.remoteMtime,
        }
      : undefined;
    const result = this.mergeEngine.merge(base, local, remote, mergeCtx);
    // Feature 039 (FR-039-5, P2): the merge produced nested/stacked markers (corruption fingerprint) →
    // never write or push it; hold for the user instead of growing the file further.
    if (result.hold) {
      return { action: 'safe-hold' };
    }
    if (result.success && !result.hadConflicts) {
      return { action: 'write', content: result.mergedContent, clean: true };
    }
    // Merge refused (diverging frontmatter) or the expansion guard fired (FR-005b): the reconcile
    // result is untrustworthy, so write full-file conflict markers for the user to resolve (FR-005).
    return { action: 'write', content: this.buildMarkerContent(local, remote), clean: false };
  }

  /**
   * biggest-size / latest-mtime: prefer the larger metric (local > remote → keep local). Equal → tie
   * no-op success (FR-009). Missing context (should not happen from SyncEngine) falls back to safe-hold.
   */
  private decideByComparison(localMetric?: number, remoteMetric?: number): ConflictResolution {
    if (localMetric === undefined || remoteMetric === undefined) return { action: 'safe-hold' };
    if (localMetric === remoteMetric) return { action: 'no-op' };
    return localMetric > remoteMetric ? { action: 'prefer-local' } : { action: 'prefer-remote' };
  }

  /**
   * Compute the content a resolution would write, WITHOUT touching disk (pure). Mirrors decide()'s
   * decision so callers can compute the resolved content independently of the write path.
   * For safe-hold / no-op → keep local (no change); prefer-local → local; prefer-remote → remote.
   * `clean` is true only when the outcome leaves no markers / unresolved state.
   */
  computeResolution(
    path: string, base: string, local: string, remote: string, ctx?: ConflictContext,
  ): { content: string; clean: boolean; conflictRegions: number } {
    const decision = this.decide(path, base, local, remote, ctx);
    switch (decision.action) {
      case 'write':
        return { content: decision.content, clean: decision.clean, conflictRegions: decision.clean ? 0 : -1 };
      case 'prefer-local':
        return { content: local, clean: true, conflictRegions: 0 };
      case 'prefer-remote':
        return { content: remote, clean: true, conflictRegions: 0 };
      case 'no-op':
        // Tie: both sides left as-is; not conflicted (success).
        return { content: local, clean: true, conflictRegions: 0 };
      case 'safe-hold':
      default:
        return { content: local, clean: false, conflictRegions: -1 };
    }
  }

  /** Build full-file conflict-marker content (both versions kept). */
  private buildMarkerContent(local: string, remote: string): string {
    const deviceSuffix = this.config.deviceId.slice(-4);
    const dateStr = new Date().toISOString().slice(0, 10);
    const markerLocal = `<<<<<<< LOCAL (${deviceSuffix}, ${dateStr})`;
    const markerRemote = `>>>>>>> REMOTE (${dateStr})`;
    return (
      markerLocal + '\n' +
      local.trimEnd() + '\n' +
      '=======\n' +
      remote.trimEnd() + '\n' +
      markerRemote + '\n'
    );
  }

  /**
   * Resolve the LOCAL side of a conflict to disk for the `write` action (clean merge or markers).
   * For safe-hold / no-op / prefer-local / prefer-remote, the resolution involves network I/O and is
   * performed by SyncEngine.handleConflict; this method does nothing and returns false for those.
   * Returns true only when auto-merge fully resolved with no markers remaining.
   */
  async resolve(
    path: string, base: string, local: string, remote: string, ctx?: ConflictContext,
  ): Promise<boolean> {
    const decision = this.decide(path, base, local, remote, ctx);
    if (decision.action === 'write') {
      await this.localAdapter.atomicWrite(path, decision.content);
      return decision.clean;
    }
    return false;
  }

  /** Returns true if the file still contains unresolved conflict markers. */
  hasConflictMarkers(content: string): boolean {
    return CONFLICT_MARKER_RE.test(content);
  }

  /** Remove the #conflict tag from file content (call after user resolves). */
  stripConflictTag(content: string): string {
    return content.replace(new RegExp(`\\n?${CONFLICT_TAG}\\n?`, 'g'), '\n').trim() + '\n';
  }
}
