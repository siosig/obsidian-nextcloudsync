import { MergeResult } from '../../types';
import { IMergeStrategy } from './IMergeStrategy';
import { ReconcileTextStrategy } from './ReconcileTextStrategy';
import { Diff3Strategy } from './Diff3Strategy';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

export interface MergeEngineOptions {
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
    // 1. Separate frontmatter
    const { frontmatter: localFm, body: localBody } = this.splitFrontmatter(local);
    const { frontmatter: remoteFm, body: remoteBody } = this.splitFrontmatter(remote);
    const { body: baseBody } = this.splitFrontmatter(base);

    // 2. If frontmatter differs → refuse auto-merge (Critical: FR-010)
    if (localFm !== remoteFm) {
      return { success: false, mergedContent: local, hadConflicts: true, conflictRegions: -1 };
    }

    // 3. Try reconcile-text first
    let result = this.primaryStrategy.merge(baseBody, localBody, remoteBody);

    // 4. If reconcile-text failed, fall back to diff3
    if (!result.success || result.conflictRegions < 0) {
      result = this.fallbackStrategy.merge(baseBody, localBody, remoteBody);
    }

    // 5. Circuit breaker: too many conflict regions
    if (result.conflictRegions > this.opts.maxConflictRegions) {
      return { success: false, mergedContent: local, hadConflicts: true, conflictRegions: result.conflictRegions };
    }

    // 6. Circuit breaker: content loss detection (< 50% of longer original)
    const maxOriginal = Math.max(localBody.length, remoteBody.length);
    if (maxOriginal > 0 && result.mergedContent.length < maxOriginal * 0.5) {
      return { success: false, mergedContent: local, hadConflicts: true, conflictRegions: result.conflictRegions };
    }

    // 7. Re-attach frontmatter (use local's frontmatter since they're identical)
    const merged = localFm ? `${localFm}\n${result.mergedContent}` : result.mergedContent;
    return { ...result, mergedContent: merged };
  }

  private splitFrontmatter(content: string): { frontmatter: string; body: string } {
    const m = content.match(FRONTMATTER_RE);
    if (!m) return { frontmatter: '', body: content };
    return { frontmatter: m[0], body: content.slice(m[0].length).trimStart() };
  }
}
