import { App } from 'obsidian';
import { ConflictResolution, ConflictStrategy, MergeContext, SyncStrategy } from '../types';
import { LocalAdapter } from '../data/LocalAdapter';
import { MergeEngine } from './merge/MergeEngine';
import { isAutoMergeFileType, isMarkdown } from '../util/mergeableExtensions';

const CONFLICT_TAG = '#conflict';
const CONFLICT_MARKER_RE = /^<<<<<<< /m;

/**
 * Feature 039 (FR-039-4): match THIS plugin's OWN conflict-marker lines — the opening line written by
 * `buildMarkerContent` / Diff3Strategy (`<<<<<<< LOCAL …`) and its closing line (`>>>>>>> REMOTE …`).
 * Stricter than CONFLICT_MARKER_RE (`^<<<<<<< `, which matches any `<<<<<<< whatever`): a user may
 * legitimately write a bare `<<<<<<< HEAD` in a note, and that must NOT trip the re-entrancy guard.
 */
const OPEN_MARKER_RE = /^<<<<<<< LOCAL/m;
const CLOSE_MARKER_RE = /^>>>>>>> REMOTE/m;

/**
 * Feature 041: `content` carries a COMPLETE plugin marker set — BOTH an opening `<<<<<<< LOCAL` line
 * and a closing `>>>>>>> REMOTE` line. Only a complete set is the re-entrancy risk: merging it would
 * re-wrap the existing markers in new markers and duplicate the shared block (the geometric-growth
 * loop feature 039 guards against). A lone half-marker (see {@link hasOrphanMarker}) is NOT that risk.
 */
export function hasCompleteMarkerSet(content: string): boolean {
  return OPEN_MARKER_RE.test(content) && CLOSE_MARKER_RE.test(content);
}

/**
 * Feature 041: `content` carries an ORPHAN half-marker — exactly ONE of the opening / closing plugin
 * marker lines, not both. This happens when a user resolves a conflict manually but forgets to delete
 * the trailing `>>>>>>> REMOTE` line (or the leading `<<<<<<< LOCAL` line). Such a leftover must NOT
 * be treated as re-entrant: doing so drops the file to a permanent safe-hold that never pushes, so the
 * orphan line survives on the server and the file re-conflicts every sync forever. Instead it is fed
 * through the normal 3-way merge, which converges and pushes the cleaned content (self-heal).
 */
export function hasOrphanMarker(content: string): boolean {
  return OPEN_MARKER_RE.test(content) !== CLOSE_MARKER_RE.test(content);
}

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
  /**
   * Feature 047: how to resolve a markdown file's frontmatter block, independently of the body. Same
   * five strategies as the body; `merge` = semantic merge. Applies to every `.md`. Defaults to 'merge'.
   */
  frontmatterStrategy: SyncStrategy;
  /**
   * Feature 048: second-level fallback for a part a primary `merge` could not auto-resolve (a body diff3
   * conflict region, or a frontmatter scalar clash). Threaded into MergeContext. Defaults to
   * 'conflict-markers'.
   */
  conflictStrategy: ConflictStrategy;
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
    // Feature 048: the MergeEngine resolves body conflict regions and frontmatter clashes per
    // `conflictStrategy`; there is no region-count cap any more (each region is resolved, not counted).
    this.mergeEngine = new MergeEngine();
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
    // Feature 048: markdown is ALWAYS special-cased (regardless of autoMergeFileTypes) — its frontmatter
    // is resolved by `frontmatterStrategy` and its body by `autoMergeFileStrategy`, independently. Every
    // non-markdown file keeps the whole-file path below (Auto Merge File → autoMergeFileStrategy, Other
    // File → otherFileStrategy).
    if (isMarkdown(path)) {
      return this.decideMarkdown(path, base, local, remote, ctx);
    }
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

  /** Feature 048: MergeContext threaded to the engine, carrying the mtimes and the conflictStrategy. */
  private mergeCtx(ctx?: ConflictContext): MergeContext {
    return {
      localMtime: ctx?.localMtime ?? 0,
      remoteMtime: ctx?.remoteMtime ?? 0,
      conflictStrategy: this.config.conflictStrategy,
    };
  }

  /**
   * `merge` strategy for a NON-markdown whole file: 3-way merge with per-region `conflictStrategy`
   * resolution. Binary content cannot carry markers → safe-hold under `conflict-markers`, otherwise a
   * deterministic whole-file pick. A complete plugin marker set safe-holds (re-entrancy guard).
   */
  private decideMerge(base: string, local: string, remote: string, ctx?: ConflictContext): ConflictResolution {
    // Non-text content cannot carry conflict markers. Under `conflict-markers` (or absent context) it
    // safe-holds (both sides untouched, flagged); under a deterministic conflictStrategy it is a
    // whole-file pick handled by the caller's action mapping.
    if (isLikelyBinary(local) || isLikelyBinary(remote)) {
      return this.binaryConflict(ctx);
    }
    // Feature 039 (FR-039-1/2, R2) + feature 041: if EITHER side already carries a COMPLETE plugin
    // marker set (opening AND closing lines), merging would re-wrap the existing markers in NEW markers
    // and duplicate shared blocks — the geometric re-entrancy loop that corrupted real files. Do NOT
    // merge: safe-hold (both untouched, flagged conflicted, nothing pushed) until the user resolves by
    // removing the markers. Self-healing: once the markers are gone the inputs are clean again and the
    // normal merge below resumes.
    //
    // A LONE half-marker (only `<<<<<<< LOCAL` or only `>>>>>>> REMOTE`, from an incomplete manual
    // resolution) is deliberately NOT treated as re-entrant: it is not the geometric-growth risk, and
    // treating it as one drops the file to a permanent safe-hold that never pushes — so the orphan line
    // survives on the server and the file re-conflicts every sync forever (the deadlock feature 041
    // fixes). Such input falls through to the normal 3-way merge, which converges and pushes the
    // cleaned content (self-heal). Orphan detection is logged by SyncEngine.handleConflict.
    if (hasCompleteMarkerSet(local) || hasCompleteMarkerSet(remote)) {
      return { action: 'safe-hold' };
    }
    const result = this.mergeEngine.merge(base, local, remote, this.mergeCtx(ctx));
    // Feature 039 (FR-039-5, P2): the merge produced nested/stacked markers (corruption fingerprint) →
    // never write or push it; hold for the user instead of growing the file further.
    if (result.hold) {
      return { action: 'safe-hold' };
    }
    // Feature 048: the engine has already applied conflictStrategy per region — the content is the final
    // resolution (markers only when conflictStrategy is conflict-markers). Clean unless markers remain.
    return { action: 'write', content: result.mergedContent, clean: result.success && !result.hadConflicts };
  }

  /**
   * Feature 048: a binary file the `merge` strategy cannot line-merge. Under conflict-markers it
   * safe-holds (markers would corrupt binary); under a deterministic conflictStrategy it maps to a
   * whole-file prefer-local / prefer-remote (size/mtime handled via ctx), so both sides converge.
   */
  private binaryConflict(ctx?: ConflictContext): ConflictResolution {
    switch (this.config.conflictStrategy) {
      case 'local-win':
        return { action: 'prefer-local' };
      case 'remote-win':
        return { action: 'prefer-remote' };
      case 'biggest-size':
        return this.decideByComparison(ctx?.localSize, ctx?.remoteSize);
      case 'latest-mtime':
        return this.decideByComparison(ctx?.localMtime, ctx?.remoteMtime);
      case 'conflict-markers':
      default:
        return { action: 'safe-hold' };
    }
  }

  /**
   * Feature 047: resolve a markdown conflict with the frontmatter and body handled by INDEPENDENT
   * strategies. Binary content or a complete plugin marker set (body re-entrancy) safe-holds — the
   * same guards as `decideMerge`. Otherwise the MergeEngine composes `frontmatterStrategy(frontmatter)`
   * with `bodyStrategy(body)`; any body markers stay in the body (never the `---` block). The result is
   * a single composed content written locally and pushed (a whole-side pick still produces a `write` of
   * the composed file, not a prefer-local/remote of the raw side, because the two halves may differ).
   */
  private decideMarkdown(path: string, base: string, local: string, remote: string, ctx?: ConflictContext): ConflictResolution {
    // A binary "markdown" file (rare) cannot be line-merged; only meaningful if the body strategy is
    // merge — otherwise the whole-side pick below is fine. Treat it like a body binary conflict.
    if ((isLikelyBinary(local) || isLikelyBinary(remote)) && this.config.autoMergeFileStrategy === 'merge') {
      return this.binaryConflict(ctx);
    }
    if (hasCompleteMarkerSet(local) || hasCompleteMarkerSet(remote)) {
      return { action: 'safe-hold' };
    }
    // Feature 048: markdown body ALWAYS uses `autoMergeFileStrategy` (never otherFileStrategy), even
    // when `md` is not in autoMergeFileTypes. Frontmatter uses `frontmatterStrategy`. conflictStrategy
    // (threaded via ctx) resolves any part a `merge` primary could not auto-resolve.
    const result = this.mergeEngine.resolveMarkdown(base, local, remote, {
      frontmatterStrategy: this.config.frontmatterStrategy,
      bodyStrategy: this.config.autoMergeFileStrategy,
      ctx: this.mergeCtx(ctx),
    });
    if (result.hold) {
      return { action: 'safe-hold' };
    }
    return { action: 'write', content: result.mergedContent, clean: result.success && !result.hadConflicts };
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
