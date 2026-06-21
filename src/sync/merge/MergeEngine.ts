import { MergeResult } from '../../types';
import { IMergeStrategy } from './IMergeStrategy';
import { ReconcileTextStrategy } from './ReconcileTextStrategy';
import { Diff3Strategy } from './Diff3Strategy';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

interface MergeEngineOptions {
  maxConflictRegions: number;
  /** What to do when frontmatter differs. Default 'conflict' inserts markers for the whole file. */
  frontmatterConflictStrategy?: 'local-wins' | 'remote-wins' | 'conflict';
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
        const strategy = this.opts.frontmatterConflictStrategy ?? 'conflict';
        if (strategy === 'conflict') {
          // Cannot reconcile frontmatter → mark the whole file (caller embeds conflict markers).
          return { success: false, mergedContent: local, hadConflicts: true, conflictRegions: -1 };
        }
        mergedFm = strategy === 'local-wins' ? localFm : remoteFm;
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
   * conflicts (docs/spec.md §6.2; fixes §18 F5 — it was dead because reconcile's count was always 0).
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
