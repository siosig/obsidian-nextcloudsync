import { MergeResult } from '../../types';
import { IMergeStrategy } from './IMergeStrategy';
import { ReconcileTextStrategy } from './ReconcileTextStrategy';
import { Diff3Strategy } from './Diff3Strategy';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

interface MergeEngineOptions {
  maxConflictRegions: number;
}

export class MergeEngine {
  private readonly primaryStrategy: IMergeStrategy;
  private readonly fallbackStrategy: IMergeStrategy;

  constructor(private readonly opts: MergeEngineOptions) {
    this.primaryStrategy = new ReconcileTextStrategy();
    this.fallbackStrategy = new Diff3Strategy();
  }

  /**
   * Attempt to merge base/local/remote text.
   * Returns a MergeResult describing the outcome.
   * Returns success=false if frontmatter conflicts or circuit breakers trigger.
   */
  merge(base: string, local: string, remote: string): MergeResult {
    // 1. Separate frontmatter from body on all three sides.
    const { frontmatter: localFm, body: localBody } = this.splitFrontmatter(local);
    const { frontmatter: remoteFm, body: remoteBody } = this.splitFrontmatter(remote);
    const { frontmatter: baseFm, body: baseBody } = this.splitFrontmatter(base);

    // 2. Resolve the frontmatter.
    let mergedFm: string;
    if (localFm === remoteFm) {
      mergedFm = localFm; // identical on both sides
    } else {
      // Merge the frontmatter line-by-line with diff3 (NOT reconcile-text, which would silently
      // concatenate and could duplicate YAML keys). Accept it only when it merges cleanly (no
      // conflicting regions — i.e. the two sides changed different lines); otherwise fall back
      // to the configured strategy.
      const fmResult = this.fallbackStrategy.merge(baseFm, localFm, remoteFm);
      if (fmResult.success && fmResult.conflictRegions === 0) {
        mergedFm = fmResult.mergedContent;
      } else {
        // Cannot reconcile diverging frontmatter → the whole file is a conflict (feature 037, FR-005):
        // the caller embeds conflict markers for text, or holds a non-text file untouched (FR-005a).
        return { success: false, mergedContent: local, hadConflicts: true, conflictRegions: -1 };
      }
    }

    // 3. Merge the body (reconcile-text → diff3 fallback).
    const result = this.mergeText(baseBody, localBody, remoteBody);

    // 4. Circuit breaker: too many conflict regions in the body.
    // `maxConflictRegions === 0` means unlimited — never cap on region count (the content-loss
    // breaker below still applies). A positive value caps as before.
    if (this.opts.maxConflictRegions !== 0 && result.conflictRegions > this.opts.maxConflictRegions) {
      return { success: false, mergedContent: local, hadConflicts: true, conflictRegions: result.conflictRegions };
    }

    // 5. Circuit breaker: content loss detection (< 50% of the longer original body).
    const maxOriginal = Math.max(localBody.length, remoteBody.length);
    if (maxOriginal > 0 && result.mergedContent.length < maxOriginal * 0.5) {
      return { success: false, mergedContent: local, hadConflicts: true, conflictRegions: result.conflictRegions };
    }

    // 5b. Expansion circuit breaker (feature 037, FR-005b). The 3-way merge here runs with an EMPTY
    // base (the State DB stores only hashes, never base content — true-base support is feature 038),
    // so reconcile-text can DUPLICATE shared blocks: the known data-bloat bug. Two cheap, base-free
    // signals catch it and downgrade the result to a conflict (markers for text / safe-hold for
    // non-text) rather than writing the corrupted body:
    //   (1) length overflow — a true union of two texts can never exceed their combined length, so a
    //       longer result is unambiguous duplication;
    //   (2) an immediately-repeated multi-line block — the visible fingerprint of the reconcile bug.
    // (2) can false-positive on genuinely repetitive prose, but only downgrades to a (non-destructive)
    // conflict the user resolves — never silent corruption. Removed once 038 supplies a real base.
    // Only the reconcile clean path (hadConflicts === false) is guarded: the diff3 fallback already
    // emits conflict markers and is intentionally longer, so it must not trip the length check.
    if (
      !result.hadConflicts &&
      (result.mergedContent.length > localBody.length + remoteBody.length ||
        hasRepeatedBlock(result.mergedContent))
    ) {
      return { success: false, mergedContent: local, hadConflicts: true, conflictRegions: result.conflictRegions };
    }

    // 6. Re-attach the resolved frontmatter.
    const merged = mergedFm ? `${mergedFm}\n${result.mergedContent}` : result.mergedContent;
    return { ...result, mergedContent: merged };
  }

  /**
   * Produce the merged body. reconcile-text (CRDT) yields a non-destructive merge but ALWAYS reports
   * conflictRegions:0 — it cannot surface real conflicts — so we additionally run diff3 purely to
   * COUNT the real conflict regions, feeding the maxConflictRegions circuit breaker (merge() step 4).
   * Reconcile's merged content is kept and hadConflicts stays false: with the default cap of 0
   * (unlimited) the reconcile merge is accepted as-is; only a positive cap exceeded by the diff3
   * region count routes the file to conflictFailurePolicy. This revives the breaker for body
   * conflicts (specs/main/spec.md §6.2; fixes §18 F5 — it was dead because reconcile's count was always 0).
   *
   * Note: the State DB stores only hashes, never base content, so `base` here is empty ('') for body
   * merges driven by SyncEngine.handleConflict. diff3 with an empty base degrades to a conservative
   * 2-way detection (identical regions reconcile via excludeFalseConflicts; divergent regions count
   * as conflicts) — a sound, slightly over-conservative signal for the region-count breaker.
   *
   * If reconcile cannot produce text, fall back to diff3 entirely (markers + count).
   */
  private mergeText(base: string, local: string, remote: string): MergeResult {
    const reconciled = this.primaryStrategy.merge(base, local, remote);
    if (!reconciled.success || reconciled.conflictRegions < 0) {
      return this.fallbackStrategy.merge(base, local, remote);
    }
    const regionCount = this.fallbackStrategy.merge(base, local, remote).conflictRegions;
    return {
      success: true,
      mergedContent: reconciled.mergedContent,
      hadConflicts: false,
      conflictRegions: regionCount >= 0 ? regionCount : 0,
    };
  }

  private splitFrontmatter(content: string): { frontmatter: string; body: string } {
    const m = content.match(FRONTMATTER_RE);
    if (!m) return { frontmatter: '', body: content };
    return { frontmatter: m[0], body: content.slice(m[0].length).trimStart() };
  }
}

/** Largest block length checked for immediate repetition — bounds cost on large files. */
const MAX_REPEAT_BLOCK = 64;

/**
 * True when `text` contains a block of ≥2 non-blank lines immediately followed by an identical block
 * (e.g. `…\nA\nB\nA\nB\n…`). This is the visible fingerprint of reconcile-text duplicating a shared
 * region when merging with an empty base (feature 037 FR-005b). We only check immediate repetition
 * (offset == block length), which is the bug's signature, and bound the block length for performance.
 */
function hasRepeatedBlock(text: string): boolean {
  const lines = text.split('\n');
  const n = lines.length;
  for (let i = 0; i < n; i++) {
    const maxK = Math.min(MAX_REPEAT_BLOCK, Math.floor((n - i) / 2));
    for (let k = 2; k <= maxK; k++) {
      let dup = true;
      let hasContent = false;
      for (let j = 0; j < k; j++) {
        if (lines[i + j] !== lines[i + k + j]) { dup = false; break; }
        if (lines[i + j].trim().length > 0) hasContent = true;
      }
      if (dup && hasContent) return true;
    }
  }
  return false;
}
