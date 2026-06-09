import { MergeResult } from '../../types';
import { IMergeStrategy } from './IMergeStrategy';
import { ReconcileTextStrategy } from './ReconcileTextStrategy';
import { Diff3Strategy } from './Diff3Strategy';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

export interface MergeEngineOptions {
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
    if (result.conflictRegions > this.opts.maxConflictRegions) {
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

  /** Merge with the primary strategy, falling back to diff3 when it cannot produce a result. */
  private mergeText(base: string, local: string, remote: string): MergeResult {
    let result = this.primaryStrategy.merge(base, local, remote);
    if (!result.success || result.conflictRegions < 0) {
      result = this.fallbackStrategy.merge(base, local, remote);
    }
    return result;
  }

  private splitFrontmatter(content: string): { frontmatter: string; body: string } {
    const m = content.match(FRONTMATTER_RE);
    if (!m) return { frontmatter: '', body: content };
    return { frontmatter: m[0], body: content.slice(m[0].length).trimStart() };
  }
}
