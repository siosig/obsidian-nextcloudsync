import { getFrontMatterInfo } from 'obsidian';
import { ConflictStrategy, MergeContext, MergeResult, SyncStrategy } from '../../types';
import { FrontmatterMergeStrategy } from './FrontmatterMergeStrategy';
import { ReconcileTextStrategy } from './ReconcileTextStrategy';

interface Diff3Chunk {
  ok?: string[];
  conflict?: { a: string[]; b: string[] };
}

// Two-level resolution: markdown frontmatter and body resolve independently; a part a `merge` primary
// cannot auto-resolve falls to `ctx.conflictStrategy`. Frontmatter never carries a marker line
// (docs/spec.md §6.0).
export class MergeEngine {
  private readonly fmStrategy = new FrontmatterMergeStrategy();
  private readonly reconcile = new ReconcileTextStrategy();

  // Non-markdown entry: the whole content is one body. A leading `---` block is not guaranteed to be YAML,
  // and routing it as frontmatter could silently discard a one-sided edit inside it.
  merge(base: string, local: string, remote: string, ctx?: MergeContext): MergeResult {
    const cs = ctx?.conflictStrategy ?? 'conflict-markers';
    const body = this.resolveBodyBlock('merge', cs, base, local, remote, ctx);
    // Nested-marker backstop, as in resolveMarkdown.
    // Same nested-marker backstop as resolveMarkdown: stacked markers ⇒ hold, never persist.
    if (hasNestedConflictMarkers(body.content)) {
      return { success: false, mergedContent: local, hadConflicts: true, conflictRegions: -1, hold: true };
    }
    return { success: true, mergedContent: body.content, hadConflicts: body.hadConflicts, conflictRegions: body.hadConflicts ? -1 : 0 };
  }

  // `hold` tells the caller to safe-hold (nested markers).
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

    // Stacked markers indicate a bypassed guard: never persist, signal hold.
    if (hasNestedConflictMarkers(merged)) {
      return { success: false, mergedContent: local, hadConflicts: true, conflictRegions: -1, hold: true };
    }
    return { success: true, mergedContent: merged, hadConflicts: body.hadConflicts, conflictRegions: body.hadConflicts ? -1 : 0 };
  }

  // Always marker-free: an unparseable side picks a whole side, with `conflict-markers` degraded to
  // latest-mtime because `---` cannot hold markers.
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

  private fmFallbackStrategy(conflictStrategy: ConflictStrategy): SyncStrategy {
    return conflictStrategy === 'conflict-markers' ? 'latest-mtime' : conflictStrategy;
  }

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

  // An empty base makes diff3 a conservative 2-way (every divergent line a conflict), still resolved
  // deterministically, never silently duplicated.
  private mergeBodyByRegions(
    base: string, local: string, remote: string, conflictStrategy: ConflictStrategy, ctx?: MergeContext,
  ): { content: string; hadConflicts: boolean } {
    // Empty base: diff3 cannot tell a non-overlapping edit from a conflict, so reconcile-text produces the
    // union, guarded against its known duplication and fusion bugs below.
    if (base.length === 0) {
      // One empty side cannot fuse with anything; it resolves to the non-empty side (local !== remote here).
      if (local.length === 0 || remote.length === 0) {
        return { content: local.length === 0 ? remote : local, hadConflicts: false };
      }
      const reconciled = this.reconcile.merge('', local, remote);
      // reconcile-text can fuse two independent edits at the character level ('local' + 'remote' ->
      // 'localremote') without flagging a conflict, so require every line of each side to survive intact.
      // Skipped for marker-bearing content: orphan-marker self-heal deliberately re-unions it.
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
      // node-diff3 ships only an `exports` map (no `main`), so an ESM import fails under ts-jest's legacy
      // `moduleResolution: "node"` (TS2307); require() works under both that and esbuild.
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

  // Uses Obsidian's getFrontMatterInfo, so only a leading `---` fence counts and a body thematic break is
  // never a delimiter. Returns a normalized `---\n<inner>\n---` block so equal frontmatter compares equal.
  private splitFrontmatter(content: string): { frontmatter: string; body: string } {
    const info = getFrontMatterInfo(content);
    if (!info.exists) return { frontmatter: '', body: content };
    const frontmatter = `---\n${info.frontmatter}\n---`;
    return { frontmatter, body: content.slice(info.contentStart).trimStart() };
  }

  // `biggest-size` compares block length and falls back to latest-mtime on a tie (never a no-op); a mtime
  // tie goes to remote.
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

// A second opening marker before the prior region closes is the fingerprint of marker re-entrancy. Only
// this plugin's marker lines count, so a bare `<<<<<<< HEAD` content line is ignored.
export function hasNestedConflictMarkers(content: string): boolean {
  let open = false;
  for (const line of content.split('\n')) {
    if (line.startsWith('<<<<<<< LOCAL')) {
      if (open) return true;
      open = true;
    } else if (line.startsWith('>>>>>>> REMOTE')) {
      open = false;
    }
  }
  return false;
}

function containsMarkerLine(text: string): boolean {
  return text.split('\n').some((l) => l.startsWith('<<<<<<<') || l.startsWith('>>>>>>>'));
}

// True when every line of `side` survives, in order, as an exact line of `merged`. Catches reconcile-text's
// character-level fusion of two independent edits, which the length and repeated-block guards miss because
// a pure concatenation is exactly local.length + remote.length. O(n): `i` only advances.
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

// Bounds the cost on large files.
const MAX_REPEAT_BLOCK = 64;

// A block of 2+ non-blank lines immediately followed by an identical block is the fingerprint of
// reconcile-text duplicating a shared region on an empty base.
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
