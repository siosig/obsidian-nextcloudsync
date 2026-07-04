import { getFrontMatterInfo } from 'obsidian';
import { MergeContext, MergeResult } from '../../types';
import { IMergeStrategy } from './IMergeStrategy';
import { ReconcileTextStrategy } from './ReconcileTextStrategy';
import { Diff3Strategy } from './Diff3Strategy';
import { FrontmatterMergeStrategy } from './FrontmatterMergeStrategy';

interface MergeEngineOptions {
  maxConflictRegions: number;
}

export class MergeEngine {
  private readonly primaryStrategy: IMergeStrategy;
  private readonly fallbackStrategy: IMergeStrategy;
  private readonly fmStrategy: FrontmatterMergeStrategy;

  constructor(private readonly opts: MergeEngineOptions) {
    this.primaryStrategy = new ReconcileTextStrategy();
    this.fallbackStrategy = new Diff3Strategy();
    this.fmStrategy = new FrontmatterMergeStrategy();
  }

  /**
   * Attempt to merge base/local/remote text.
   * Returns a MergeResult describing the outcome.
   * Returns success=false if frontmatter conflicts or circuit breakers trigger.
   */
  merge(base: string, local: string, remote: string, ctx?: MergeContext): MergeResult {
    // 1. Separate frontmatter from body on all three sides.
    const { frontmatter: localFm, body: localBody } = this.splitFrontmatter(local);
    const { frontmatter: remoteFm, body: remoteBody } = this.splitFrontmatter(remote);
    const { frontmatter: baseFm, body: baseBody } = this.splitFrontmatter(base);

    // 2. Resolve the frontmatter. Feature 043: frontmatter is resolved STRUCTURALLY and is NEVER
    // text-diffed — the diff3 fallbackStrategy is used only for the body below, so no conflict-marker
    // line can ever appear inside a `---` block ([HFM-9]).
    let mergedFm: string;
    if (localFm === remoteFm) {
      mergedFm = localFm; // identical on both sides
    } else {
      // Semantic 3-way merge (feature 040, hardened by 043): list fields base-aware set-merge, scalars
      // 3-way resolve. `success:false` means a side is unparseable / no frontmatter — it is NOT a signal
      // to diff-text the frontmatter.
      const fmSemantic = this.fmStrategy.merge(baseFm, localFm, remoteFm, ctx);
      if (fmSemantic.success) {
        mergedFm = fmSemantic.frontmatter;
      } else {
        // [HFM-9][HFM-10] Unparseable side → pick ONE whole side's frontmatter per the scalar policy
        // (feature 043, D3). NEVER invoke the diff3 fallback on frontmatter text.
        mergedFm = this.pickWholeSide(localFm, remoteFm, ctx);
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

    // 6b. Nested-marker backstop (feature 039, FR-039-5, P2). The re-entrancy guard in
    // ConflictResolver.decideMerge already refuses to merge inputs that carry plugin markers, so a
    // well-formed single-level output is expected. If the output nonetheless contains STACKED plugin
    // markers (a second `<<<<<<< LOCAL` before the prior region's `>>>>>>> REMOTE` close), some path
    // bypassed the guard — never persist or push that corrupt body. Signal `hold` so the caller
    // safe-holds. Length-independent, so it does NOT false-positive on a legitimate single-level
    // marker output (whose size naturally exceeds max(local,remote)).
    if (hasNestedConflictMarkers(merged)) {
      return { success: false, mergedContent: local, hadConflicts: true, conflictRegions: result.conflictRegions, hold: true };
    }
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
    // Feature 039 (P3): with a REAL base (feature 038 now seeds one), diff3 is a TRUE 3-way merge —
    // non-overlapping edits merge cleanly and only genuine SAME-line edits surface as conflicts. Prefer
    // it: it both reduces false conflicts AND, unlike reconcile-text (which always reports
    // conflictRegions:0 and silently concatenates), it actually detects real same-line conflicts so the
    // caller writes proper markers. reconcile-text stays the fallback ONLY for an EMPTY base (migration
    // / a first conflict before 038 has seeded a base), where diff3 degrades to a 2-way guess.
    if (base.length > 0) {
      const d = this.fallbackStrategy.merge(base, local, remote);
      if (d.conflictRegions >= 0) {
        return { success: true, mergedContent: d.mergedContent, hadConflicts: d.hadConflicts, conflictRegions: d.conflictRegions };
      }
      // diff3 itself failed (conflictRegions < 0) → fall through to the reconcile path below.
    }
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

  /**
   * Split a note into its frontmatter block and body using Obsidian's own `getFrontMatterInfo`
   * ([HFM-8]): only a leading `---` fence is treated as frontmatter, so a `---` thematic break in the
   * body is never mistaken for a delimiter, and CRLF / trailing-space fences are tolerated. The
   * frontmatter is returned as a normalized `---\n<inner>\n---` block (LF, trimmed fences) so equal
   * frontmatter on both sides compares equal even when the raw serialization differed.
   */
  private splitFrontmatter(content: string): { frontmatter: string; body: string } {
    const info = getFrontMatterInfo(content);
    if (!info.exists) return { frontmatter: '', body: content };
    const frontmatter = `---\n${info.frontmatter}\n---`;
    return { frontmatter, body: content.slice(info.contentStart).trimStart() };
  }

  /**
   * Feature 043 (D3, [HFM-10]): when the two frontmatter sides cannot be merged structurally (a side is
   * unparseable), pick ONE whole side's frontmatter block per the scalar conflict policy — `local-win`
   * / `remote-win` take that side, `latest-mtime` (the default) takes the side with the newer file
   * mtime (remote on tie). The frontmatter is taken verbatim, so no conflict-marker line is ever added.
   */
  private pickWholeSide(localFm: string, remoteFm: string, ctx?: MergeContext): string {
    const policy = ctx?.frontmatterScalarPolicy ?? 'latest-mtime';
    if (policy === 'local-win') return localFm;
    if (policy === 'remote-win') return remoteFm;
    const localMtime = ctx?.localMtime ?? 0;
    const remoteMtime = ctx?.remoteMtime ?? 0;
    return localMtime > remoteMtime ? localFm : remoteFm;
  }
}

/**
 * Feature 039 (FR-039-5): true when `content` contains NESTED/stacked plugin conflict markers — a
 * second opening marker (`<<<<<<< LOCAL`) appears before the current region's closing marker
 * (`>>>>>>> REMOTE`). That is the fingerprint of marker re-entrancy (a marked file fed back into the
 * merge and re-wrapped). A single well-formed region (one LOCAL open … one REMOTE close) is NOT
 * nested, and a note that merely contains a bare `<<<<<<< HEAD` content line is ignored — only THIS
 * plugin's marker lines (`^<<<<<<< LOCAL` / `^>>>>>>> REMOTE`) are tracked.
 */
export function hasNestedConflictMarkers(content: string): boolean {
  let open = false;
  for (const line of content.split('\n')) {
    if (line.startsWith('<<<<<<< LOCAL')) {
      if (open) return true; // a second open before the prior region closed → nested
      open = true;
    } else if (line.startsWith('>>>>>>> REMOTE')) {
      open = false;
    }
  }
  return false;
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
