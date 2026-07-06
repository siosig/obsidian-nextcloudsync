import { getFrontMatterInfo } from 'obsidian';
import { ConflictStrategy, MergeContext, MergeResult, SyncStrategy } from '../../types';
import { FrontmatterMergeStrategy } from './FrontmatterMergeStrategy';
import { ReconcileTextStrategy } from './ReconcileTextStrategy';

interface Diff3Chunk {
  ok?: string[];
  conflict?: { a: string[]; b: string[] };
}

/**
 * Two-level conflict resolution (feature 048). A markdown note is split into a frontmatter half
 * (resolved by `frontmatterStrategy`) and a body half (resolved by `bodyStrategy`); a non-markdown file
 * is one body. When a `merge` primary strategy cannot auto-resolve a part — a body diff3 conflict
 * region, or a frontmatter scalar/object both-changed clash — that PART is resolved by the second-level
 * `ctx.conflictStrategy` (per body region / per frontmatter field): `conflict-markers` writes markers
 * (frontmatter falls back to latest-mtime, since `---` cannot hold markers), the four deterministic
 * values pick one side. Frontmatter never carries a marker line.
 */
export class MergeEngine {
  private readonly fmStrategy = new FrontmatterMergeStrategy();
  private readonly reconcile = new ReconcileTextStrategy();

  /**
   * Whole-file merge entry for NON-markdown files (bug G3-3). The only production caller,
   * `ConflictResolver.decideMerge`, is reached solely when `!isMarkdown(path)`; markdown goes through
   * {@link resolveMarkdown}. The entire content is 3-way merged as ONE body — a leading `---...---`
   * block is NEVER split off as frontmatter here, because a non-markdown file's `---` block is not
   * guaranteed to be YAML: routing it through the frontmatter path meant an unparseable "frontmatter"
   * side fell back to a silent whole-side pick (`pickWholeSide`) that could DISCARD a one-sided edit
   * inside that block instead of diff3-merging it like the rest of the file. Only real markdown gets
   * frontmatter/body independence.
   */
  merge(base: string, local: string, remote: string, ctx?: MergeContext): MergeResult {
    const cs = ctx?.conflictStrategy ?? 'conflict-markers';
    const body = this.resolveBodyBlock('merge', cs, base, local, remote, ctx);
    // Same nested-marker backstop as resolveMarkdown: stacked markers ⇒ hold, never persist.
    if (hasNestedConflictMarkers(body.content)) {
      return { success: false, mergedContent: local, hadConflicts: true, conflictRegions: -1, hold: true };
    }
    return { success: true, mergedContent: body.content, hadConflicts: body.hadConflicts, conflictRegions: body.hadConflicts ? -1 : 0 };
  }

  /**
   * Feature 047/048: resolve a markdown conflict — frontmatter by `frontmatterStrategy`, body by
   * `bodyStrategy` — independently, then recompose. A `merge` primary that hits a genuine conflict
   * defers that part to `ctx.conflictStrategy`. `hold` signals the caller to safe-hold (nested markers).
   */
  resolveMarkdown(
    base: string,
    local: string,
    remote: string,
    opts: {
      frontmatterStrategy: SyncStrategy;
      bodyStrategy: SyncStrategy;
      ctx?: MergeContext;
    },
  ): MergeResult {
    const cs = opts.ctx?.conflictStrategy ?? 'conflict-markers';
    const { frontmatter: localFm, body: localBody } = this.splitFrontmatter(local);
    const { frontmatter: remoteFm, body: remoteBody } = this.splitFrontmatter(remote);
    const { frontmatter: baseFm, body: baseBody } = this.splitFrontmatter(base);

    const mergedFm = this.resolveFrontmatterBlock(opts.frontmatterStrategy, baseFm, localFm, remoteFm, cs, opts.ctx);
    const body = this.resolveBodyBlock(opts.bodyStrategy, cs, baseBody, localBody, remoteBody, opts.ctx);

    const merged = mergedFm ? `${mergedFm}\n${body.content}` : body.content;

    // Nested-marker backstop (feature 039): a well-formed single body-marker set is fine; stacked
    // markers indicate a bypassed guard → never persist, signal hold so the caller safe-holds.
    if (hasNestedConflictMarkers(merged)) {
      return { success: false, mergedContent: local, hadConflicts: true, conflictRegions: -1, hold: true };
    }
    return { success: true, mergedContent: merged, hadConflicts: body.hadConflicts, conflictRegions: body.hadConflicts ? -1 : 0 };
  }

  /**
   * Resolve the frontmatter block alone — ALWAYS marker-free. `merge` runs the semantic 3-way (scalar
   * clashes resolved per-field inside FrontmatterMergeStrategy via `conflictStrategy`); an unparseable
   * side picks one whole side by `conflictStrategy` (markers → latest-mtime, since `---` cannot hold
   * markers). The other four strategies adopt one whole side's frontmatter block.
   */
  private resolveFrontmatterBlock(
    strategy: SyncStrategy, baseFm: string, localFm: string, remoteFm: string,
    conflictStrategy: ConflictStrategy, ctx?: MergeContext,
  ): string {
    if (localFm === remoteFm) return localFm;
    if (strategy === 'merge') {
      const r = this.fmStrategy.merge(baseFm, localFm, remoteFm, ctx);
      if (r.success) return r.frontmatter;
      return this.pickWholeSide(localFm, remoteFm, this.fmFallbackStrategy(conflictStrategy), ctx);
    }
    return this.pickWholeSide(localFm, remoteFm, strategy, ctx);
  }

  /** Frontmatter cannot hold markers, so `conflict-markers` degrades to latest-mtime for a whole-fm pick. */
  private fmFallbackStrategy(conflictStrategy: ConflictStrategy): SyncStrategy {
    return conflictStrategy === 'conflict-markers' ? 'latest-mtime' : conflictStrategy;
  }

  /**
   * Resolve the body block. `merge` → 3-way with per-region `conflictStrategy` resolution; the other
   * four strategies adopt one whole side's body (deterministic, never conflicts).
   */
  private resolveBodyBlock(
    strategy: SyncStrategy, conflictStrategy: ConflictStrategy,
    baseBody: string, localBody: string, remoteBody: string, ctx?: MergeContext,
  ): { content: string; hadConflicts: boolean } {
    if (localBody === remoteBody) return { content: localBody, hadConflicts: false };
    if (strategy !== 'merge') {
      return { content: this.pickWholeSide(localBody, remoteBody, strategy, ctx), hadConflicts: false };
    }
    return this.mergeBodyByRegions(baseBody, localBody, remoteBody, conflictStrategy, ctx);
  }

  /**
   * 3-way body merge (node-diff3). Non-conflicting regions merge cleanly; each genuine conflict region
   * is resolved by `conflictStrategy`: `conflict-markers` writes a marker block (leaving the file
   * conflicted), the four deterministic values pick that region's local/remote hunk (clean). An empty
   * base degrades diff3 to a conservative 2-way (every divergent line is a conflict region), still
   * resolved deterministically — never a silent duplication.
   */
  private mergeBodyByRegions(
    base: string, local: string, remote: string, conflictStrategy: ConflictStrategy, ctx?: MergeContext,
  ): { content: string; hadConflicts: boolean } {
    // Empty base (first conflict before a base is seeded, or migration): diff3 cannot tell a
    // non-overlapping edit from a conflict, so reconcile-text produces a clean union instead. The
    // feature-037 expansion guard catches reconcile's known duplication bug and degrades to a whole-body
    // conflictStrategy resolution. A real base takes the precise per-region path below.
    if (base.length === 0) {
      // A genuine first write — one side never touched (empty) — cannot fuse with anything, so it
      // always resolves cleanly to the non-empty side. (The caller guarantees local !== remote here,
      // so at most one side is empty.) This also keeps `linesSurvive` from false-flagging it below.
      if (local.length === 0 || remote.length === 0) {
        return { content: local.length === 0 ? remote : local, hadConflicts: false };
      }
      const reconciled = this.reconcile.merge('', local, remote);
      // Bug G3-1: reconcile-text can fuse the two sides at the CHARACTER level on an empty base — e.g.
      // local='local' + remote='remote' -> 'localremote' with hadConflicts:false — silently destroying
      // the line boundary between two INDEPENDENT edits. A pure concatenation is exactly
      // local.length + remote.length (not longer) and has no repeated block, so the length/repeat
      // guards miss it; require instead that every line of each side survive INTACT in the result.
      // Skipped when a side already carries a plugin conflict marker: that is the feature 041/044
      // orphan-marker self-heal path, which deliberately re-unions the marker-bearing content to
      // converge (and the nested-marker backstop still guards genuine re-entrancy).
      const guardFusion = !containsMarkerLine(local) && !containsMarkerLine(remote);
      const bloated =
        reconciled.mergedContent.length > local.length + remote.length ||
        hasRepeatedBlock(reconciled.mergedContent) ||
        (guardFusion && (!linesSurvive(local, reconciled.mergedContent) || !linesSurvive(remote, reconciled.mergedContent)));
      if (reconciled.success && reconciled.conflictRegions >= 0 && !bloated) {
        return { content: reconciled.mergedContent, hadConflicts: false };
      }
      return this.wholeConflict(local, remote, conflictStrategy, ctx);
    }

    let chunks: Diff3Chunk[];
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- CJS interop for an untyped bundled dependency (esbuild inlines this)
      const { diff3Merge } = require('node-diff3') as {
        diff3Merge: (a: string[], o: string[], b: string[], opts?: Record<string, unknown>) => Diff3Chunk[];
      };
      chunks = diff3Merge(local.split('\n'), base.split('\n'), remote.split('\n'), { excludeFalseConflicts: true });
    } catch {
      return this.wholeConflict(local, remote, conflictStrategy, ctx);
    }

    let content = '';
    let hadConflicts = false;
    for (const chunk of chunks) {
      if (chunk.ok) {
        content += this.joinLines(chunk.ok);
      } else if (chunk.conflict) {
        const { a, b } = chunk.conflict;
        if (conflictStrategy === 'conflict-markers') {
          content += `<<<<<<< LOCAL\n${this.joinLines(a)}=======\n${this.joinLines(b)}>>>>>>> REMOTE\n`;
          hadConflicts = true;
        } else {
          content += this.joinLines(this.pickRegion(a, b, conflictStrategy, ctx));
        }
      }
    }
    return { content, hadConflicts };
  }

  private joinLines(lines: string[]): string {
    return lines.length > 0 ? lines.join('\n') + '\n' : '';
  }

  /** Pick one hunk of a body conflict region by a deterministic conflictStrategy (biggest tie → mtime). */
  private pickRegion(a: string[], b: string[], conflictStrategy: ConflictStrategy, ctx?: MergeContext): string[] {
    if (conflictStrategy === 'local-win') return a;
    if (conflictStrategy === 'remote-win') return b;
    if (conflictStrategy === 'biggest-size') {
      const la = a.join('\n').length;
      const lb = b.join('\n').length;
      if (la !== lb) return la > lb ? a : b;
    }
    return (ctx?.localMtime ?? 0) > (ctx?.remoteMtime ?? 0) ? a : b;
  }

  /** diff3 failed to run → resolve the whole body by conflictStrategy (markers wrap both whole sides). */
  private wholeConflict(
    local: string, remote: string, conflictStrategy: ConflictStrategy, ctx?: MergeContext,
  ): { content: string; hadConflicts: boolean } {
    if (conflictStrategy === 'conflict-markers') {
      const l = local.endsWith('\n') ? local : local + '\n';
      const r = remote.endsWith('\n') ? remote : remote + '\n';
      return { content: `<<<<<<< LOCAL\n${l}=======\n${r}>>>>>>> REMOTE\n`, hadConflicts: true };
    }
    return { content: this.pickWholeSide(local, remote, conflictStrategy, ctx), hadConflicts: false };
  }

  /**
   * Split a note into its frontmatter block and body using Obsidian's own `getFrontMatterInfo`
   * ([HFM-8]): only a leading `---` fence is treated as frontmatter, so a `---` thematic break in the
   * body is never mistaken for a delimiter. The frontmatter is returned as a normalized
   * `---\n<inner>\n---` block (LF, trimmed fences) so equal frontmatter compares equal.
   */
  private splitFrontmatter(content: string): { frontmatter: string; body: string } {
    const info = getFrontMatterInfo(content);
    if (!info.exists) return { frontmatter: '', body: content };
    const frontmatter = `---\n${info.frontmatter}\n---`;
    return { frontmatter, body: content.slice(info.contentStart).trimStart() };
  }

  /**
   * Adopt ONE whole side's block by a deterministic strategy — used by the frontmatter whole-side
   * strategies, the non-merge body strategies, and the whole-body conflict fallback. `biggest-size`
   * compares block length and falls back to latest-mtime on a tie (never a no-op); `latest-mtime` (and
   * any unexpected value) takes the newer side; remote wins on a mtime tie. Verbatim — no marker line.
   */
  private pickWholeSide(
    localBlk: string, remoteBlk: string, strategy: Exclude<SyncStrategy, 'merge'> | SyncStrategy, ctx?: MergeContext,
  ): string {
    if (strategy === 'local-win') return localBlk;
    if (strategy === 'remote-win') return remoteBlk;
    if (strategy === 'biggest-size' && localBlk.length !== remoteBlk.length) {
      return localBlk.length > remoteBlk.length ? localBlk : remoteBlk;
    }
    return (ctx?.localMtime ?? 0) > (ctx?.remoteMtime ?? 0) ? localBlk : remoteBlk;
  }
}

/**
 * Feature 039 (FR-039-5): true when `content` contains NESTED/stacked plugin conflict markers — a
 * second opening marker (`<<<<<<< LOCAL`) appears before the current region's closing marker
 * (`>>>>>>> REMOTE`). That is the fingerprint of marker re-entrancy. A single well-formed region is NOT
 * nested, and a bare `<<<<<<< HEAD` content line is ignored — only THIS plugin's marker lines are tracked.
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

/** True when any line is one of THIS plugin's conflict-marker lines (opening or closing). */
function containsMarkerLine(text: string): boolean {
  return text.split('\n').some((l) => l.startsWith('<<<<<<<') || l.startsWith('>>>>>>>'));
}

/**
 * Bug G3-1 safety net: true when every line of `side` survives, in order, as an EXACT line somewhere
 * in `merged` (a same-order subsequence, not necessarily contiguous). reconcile-text's empty-base
 * fallback can fuse the tail of one side into the head of the other at the character level — e.g.
 * `local='Hello brave new world'` `remote='Goodbye cruel old world'` yields the single fused line
 * `'Goodbye cruel old worldHello brave new world'` with `hadConflicts:false`, silently destroying the
 * line boundary between two INDEPENDENT edits. Neither original line then survives intact, so this
 * check catches it (the length/repeated-block guards do not, since a pure concatenation is exactly
 * `local.length + remote.length`, not longer). A legitimate line-level union (shared lines kept,
 * divergent lines appended) passes, because each original line still appears verbatim. O(n) — `i`
 * only advances, never rescans from 0.
 */
function linesSurvive(side: string, merged: string): boolean {
  const sideLines = side.split('\n');
  const mergedLines = merged.split('\n');
  let i = 0;
  for (const line of sideLines) {
    while (i < mergedLines.length && mergedLines[i] !== line) i++;
    if (i >= mergedLines.length) return false;
    i++;
  }
  return true;
}

/** Largest block length checked for immediate repetition — bounds cost on large files. */
const MAX_REPEAT_BLOCK = 64;

/**
 * True when `text` contains a block of ≥2 non-blank lines immediately followed by an identical block
 * (e.g. `…\nA\nB\nA\nB\n…`) — the visible fingerprint of reconcile-text duplicating a shared region on
 * an empty base (feature 037 FR-005b). Only immediate repetition (offset == block length) is checked.
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
