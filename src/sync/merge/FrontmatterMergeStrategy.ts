import { parseYaml, stringifyYaml, parseFrontMatterStringArray, getFrontMatterInfo } from 'obsidian';
import { MergeContext } from '../../types';

export interface FrontmatterMergeResult {
  /**
   * false = the sides cannot be merged STRUCTURALLY (a side is unparseable, or neither side has
   * frontmatter). Feature 043 (D3): this is NOT a signal to run a text diff — the caller picks ONE
   * whole side's frontmatter per policy. `merge` never returns partial frontmatter with marker lines.
   */
  success: boolean;
  /** Resolved frontmatter block including --- delimiters, e.g. "---\ntags:\n  - a\n---" */
  frontmatter: string;
}

/**
 * Sentinel for a frontmatter side that cannot be parsed to a YAML mapping (parseYaml throws, or the
 * document parses to a non-object such as a list or a bare scalar). Distinct from an EMPTY block,
 * which parses to `{}`.
 */
const UNPARSEABLE = Symbol('unparseable-frontmatter');
type ParsedFm = Record<string, unknown> | typeof UNPARSEABLE;

/**
 * Semantic 3-way merge for Obsidian frontmatter (feature 043 hardening of feature 040).
 *
 * Parsing/serialization go through Obsidian's own `parseYaml` / `stringifyYaml` (never the raw YAML lib),
 * and list fields are normalized with `parseFrontMatterStringArray`, so `#tag`/`tag`, inline vs block
 * lists, and whitespace variants collapse to one canonical entry ([HFM-1][HFM-4]).
 *
 * List fields (both sides a list) resolve with a base-aware SET 3-way ([HFM-2]): presence of each
 * normalized item is binary, so a per-item disagreement between local and remote always means exactly
 * one side changed relative to base — that side wins. Deletions therefore propagate, both-side deletes
 * stay absent, and additions from either side are kept. With no base the algorithm degrades naturally
 * to a deduplicated union ([HFM-3]) — nothing can be "deleted" against an empty base. Output order is
 * stable (base order first, then additions) and deterministic, independent of mtime ([HFM-5]).
 *
 * Scalar fields resolve via `resolveScalar` with a fixed latest-mtime tiebreak (feature 047, [HFM-6]);
 * nested YAML objects stay opaque scalars.
 *
 * A side that cannot be parsed to a mapping makes `merge` return `success:false` ([HFM-7]) so the
 * caller (`MergeEngine`) picks a whole side — the frontmatter is NEVER text-diffed and NEVER carries
 * conflict-marker lines.
 */
export class FrontmatterMergeStrategy {
  merge(
    baseFm: string,
    localFm: string,
    remoteFm: string,
    ctx?: MergeContext,
  ): FrontmatterMergeResult {
    if (localFm === '' && remoteFm === '') {
      return { success: false, frontmatter: '' };
    }

    const localData = this.parseFm(localFm);
    const remoteData = this.parseFm(remoteFm);

    // Unparseable side → structural merge impossible; caller picks a whole side (never text-diffed).
    if (localData === UNPARSEABLE || remoteData === UNPARSEABLE) {
      return { success: false, frontmatter: '' };
    }

    // An unparseable base is not fatal — it only informs 3-way context, so treat it as "no base".
    const baseParsed = this.parseFm(baseFm ?? '');
    const base = baseParsed === UNPARSEABLE ? {} : baseParsed;

    const merged = this.buildMergedObject(base, localData, remoteData, ctx);
    return { success: true, frontmatter: this.serializeFm(merged) };
  }

  /**
   * Parse a frontmatter block to a mapping via Obsidian's `parseYaml`. Accepts either a `---`-wrapped
   * block (the shape `MergeEngine` passes) or bare inner YAML. Returns `{}` for an empty block,
   * `UNPARSEABLE` when parsing throws or yields a non-mapping (list / scalar), and the mapping otherwise.
   */
  private parseFm(fm: string): ParsedFm {
    if (fm === '') return {};
    const info = getFrontMatterInfo(fm);
    const inner = info.exists ? info.frontmatter : fm;
    if (inner.trim() === '') return {};
    let parsed: unknown;
    try {
      parsed = parseYaml(inner);
    } catch {
      return UNPARSEABLE;
    }
    if (parsed === null || parsed === undefined) return UNPARSEABLE;
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return UNPARSEABLE;
    return parsed as Record<string, unknown>;
  }

  private serializeFm(data: Record<string, unknown>): string {
    const yamlContent = stringifyYaml(data).trimEnd();
    return `---\n${yamlContent}\n---`;
  }

  private isYamlArray(v: unknown): v is unknown[] {
    return Array.isArray(v);
  }

  /**
   * Base-aware SET 3-way merge of one list field ([HFM-2]/[HFM-3]/[HFM-4]/[HFM-5]). Items on all three
   * sides are normalized to canonical strings via `parseFrontMatterStringArray`. Presence is binary, so
   * for each item: if local and remote agree, keep their shared verdict; if they disagree, the side that
   * differs from base is the change and wins. With an empty base this degrades to a deduplicated union.
   * Output order: base order first, then local additions, then remote additions (stable, deterministic).
   */
  private mergeArrayField(
    base: Record<string, unknown>,
    local: Record<string, unknown>,
    remote: Record<string, unknown>,
    key: string,
  ): string[] {
    const baseItems = parseFrontMatterStringArray(base, key) ?? [];
    const localItems = parseFrontMatterStringArray(local, key) ?? [];
    const remoteItems = parseFrontMatterStringArray(remote, key) ?? [];

    const baseSet = new Set(baseItems);
    const localSet = new Set(localItems);
    const remoteSet = new Set(remoteItems);

    // Stable ordering: base order first, then local-only additions, then remote-only additions.
    const order: string[] = [];
    const pushUnique = (items: string[]): void => {
      for (const it of items) if (!order.includes(it)) order.push(it);
    };
    pushUnique(baseItems);
    pushUnique(localItems);
    pushUnique(remoteItems);

    const result: string[] = [];
    for (const item of order) {
      const inBase = baseSet.has(item);
      const inLocal = localSet.has(item);
      const inRemote = remoteSet.has(item);
      // Agreement → shared verdict. Disagreement → the side that differs from base is the change.
      const present = inLocal === inRemote ? inLocal : inLocal !== inBase ? inLocal : inRemote;
      if (present) result.push(item);
    }
    return result;
  }

  private deepEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /**
   * Resolve a scalar (or nested-object, treated opaque) field present on BOTH sides with different
   * values. Feature 048: a genuine both-changed clash is a "conflict" resolved by `ctx.conflictStrategy`
   * (per-field): local-win / remote-win pick that side; latest-mtime picks the newer file; biggest-size
   * picks the larger serialized value (tie → latest-mtime); `conflict-markers` cannot be written into a
   * `---` block, so it falls back to latest-mtime. One-sided changes still auto-resolve.
   */
  private resolveScalar(
    baseVal: unknown,
    localVal: unknown,
    remoteVal: unknown,
    ctx?: MergeContext,
  ): unknown {
    const localChanged = !this.deepEqual(localVal, baseVal);
    const remoteChanged = !this.deepEqual(remoteVal, baseVal);

    if (localChanged && !remoteChanged) return localVal;
    if (!localChanged && remoteChanged) return remoteVal;
    if (!localChanged && !remoteChanged) return localVal;

    return this.pickScalarByConflict(localVal, remoteVal, ctx);
  }

  /** Pick local/remote for a both-changed scalar clash per conflictStrategy (markers → latest-mtime). */
  private pickScalarByConflict(localVal: unknown, remoteVal: unknown, ctx?: MergeContext): unknown {
    const cs = ctx?.conflictStrategy ?? 'conflict-markers';
    if (cs === 'local-win') return localVal;
    if (cs === 'remote-win') return remoteVal;
    if (cs === 'biggest-size') {
      const la = this.sizeOf(localVal);
      const lb = this.sizeOf(remoteVal);
      if (la !== lb) return la > lb ? localVal : remoteVal;
    }
    return this.localWinsByMtime(ctx) ? localVal : remoteVal;
  }

  private sizeOf(v: unknown): number {
    return JSON.stringify(v ?? null).length;
  }

  /**
   * Decide whether a DELETION wins a delete-vs-modify clash (feature 048). local-win/remote-win favour
   * that side (deletion wins only if that side is the deleter); biggest-size always keeps the value (a
   * value outsizes an absence); latest-mtime / conflict-markers(→latest) favour the newer operation.
   */
  private deletionWins(deleterIsLocal: boolean, ctx?: MergeContext): boolean {
    const cs = ctx?.conflictStrategy ?? 'conflict-markers';
    if (cs === 'local-win') return deleterIsLocal;
    if (cs === 'remote-win') return !deleterIsLocal;
    if (cs === 'biggest-size') return false; // a value (size > 0) beats a deletion (absence)
    const localNewer = this.localWinsByMtime(ctx);
    return deleterIsLocal ? localNewer : !localNewer;
  }

  /** True when the local side's edit is strictly newer than the remote's (remote wins on a tie). */
  private localWinsByMtime(ctx?: MergeContext): boolean {
    return (ctx?.localMtime ?? 0) > (ctx?.remoteMtime ?? 0);
  }

  /**
   * Base-aware 3-way merge of the frontmatter mapping (feature 047 hardens feature 043's key handling).
   *
   * Key presence is decided against base so a one-sided DELETION propagates instead of the other side's
   * value silently resurrecting it:
   *   - present on both        → equal keep; arrays set-merge; scalars resolveScalar (latest-mtime).
   *   - absent on one side:
   *       - not in base        → the other side ADDED it → keep the added value.
   *       - in base, other side unchanged → this side DELETED it → drop (deletion propagates).
   *       - in base, other side modified  → delete-vs-modify → latest-mtime tiebreak ([FR-005]/Q3).
   *   - absent on both         → deleted on both → dropped.
   */
  private buildMergedObject(
    base: Record<string, unknown>,
    local: Record<string, unknown>,
    remote: Record<string, unknown>,
    ctx?: MergeContext,
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    const has = (o: Record<string, unknown>, k: string): boolean =>
      Object.prototype.hasOwnProperty.call(o, k);

    // Union of keys: local order first, then remote-only keys appended.
    const keys = [...Object.keys(local)];
    for (const k of Object.keys(remote)) {
      if (!keys.includes(k)) keys.push(k);
    }

    for (const k of keys) {
      const inBase = has(base, k);
      const baseVal = base[k];
      const localVal = local[k];
      const remoteVal = remote[k];
      const localHas = has(local, k);
      const remoteHas = has(remote, k);

      if (!localHas && !remoteHas) continue; // deleted on both → drop

      if (!localHas) {
        // Local absent, remote present.
        if (!inBase) { merged[k] = remoteVal; continue; }        // remote added the key
        if (this.deepEqual(remoteVal, baseVal)) continue;         // remote unchanged → local delete propagates
        if (this.deletionWins(true, ctx)) continue;               // delete-vs-modify → conflictStrategy: delete wins → drop
        merged[k] = remoteVal;                                    // modify (remote) wins → keep
        continue;
      }
      if (!remoteHas) {
        // Remote absent, local present (symmetric).
        if (!inBase) { merged[k] = localVal; continue; }          // local added the key
        if (this.deepEqual(localVal, baseVal)) continue;          // local unchanged → remote delete propagates
        if (this.deletionWins(false, ctx)) continue;              // delete-vs-modify → conflictStrategy: delete wins → drop
        merged[k] = localVal;                                     // modify (local) wins → keep
        continue;
      }

      // Present on both sides.
      if (this.deepEqual(localVal, remoteVal)) {
        merged[k] = localVal;
        continue;
      }
      if (this.isYamlArray(localVal) && this.isYamlArray(remoteVal)) {
        merged[k] = this.mergeArrayField(base, local, remote, k);
        continue;
      }
      merged[k] = this.resolveScalar(baseVal, localVal, remoteVal, ctx);
    }

    return merged;
  }
}
