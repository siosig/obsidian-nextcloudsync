import { parseYaml, stringifyYaml, parseFrontMatterStringArray, getFrontMatterInfo } from 'obsidian';
import { MergeContext } from '../../types';

export interface FrontmatterMergeResult {
  // false = no structural merge (a side is unparseable, or neither has frontmatter). The caller then
  // picks one whole side; the frontmatter is never text-diffed.
  success: boolean;
  frontmatter: string;
}

// A side that is not a YAML mapping (parse error, list or bare scalar); an empty block parses to `{}`.
const UNPARSEABLE = Symbol('unparseable-frontmatter');
type ParsedFm = Record<string, unknown> | typeof UNPARSEABLE;

// Semantic 3-way merge: parsing goes through Obsidian's parseYaml/stringifyYaml so `#tag`/`tag` and inline vs
// block lists collapse to one canonical form. Lists are a base-aware set 3-way (the side that differs from
// base wins; no base degrades to a union), in a stable order independent of mtime. Scalars use a fixed
// latest-mtime tiebreak. An unparseable side returns `success:false` (docs/spec.md §6.0).
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

    if (localData === UNPARSEABLE || remoteData === UNPARSEABLE) {
      return { success: false, frontmatter: '' };
    }

    // An unparseable base is not fatal: treat it as no base.
    // An unparseable base is not fatal — it only informs 3-way context, so treat it as "no base".
    const baseParsed = this.parseFm(baseFm ?? '');
    const base = baseParsed === UNPARSEABLE ? {} : baseParsed;

    const merged = this.buildMergedObject(base, localData, remoteData, ctx);
    return { success: true, frontmatter: this.serializeFm(merged) };
  }

  // Accepts a `---`-wrapped block or bare inner YAML.
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

  // Presence of each normalized item is binary, so a disagreement between local and remote means exactly
  // one side changed relative to base, and that side wins. Order: base, local additions, remote additions.
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
      const present = inLocal === inRemote ? inLocal : inLocal !== inBase ? inLocal : inRemote;
      if (present) result.push(item);
    }
    return result;
  }

  private deepEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // A both-changed clash goes to ctx.conflictStrategy per field; `conflict-markers` cannot be written into a
  // `---` block, so it falls back to latest-mtime. One-sided changes auto-resolve.
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

  // biggest-size always keeps the value (a value outsizes an absence); latest-mtime and conflict-markers
  // favour the newer operation.
  private deletionWins(deleterIsLocal: boolean, ctx?: MergeContext): boolean {
    const cs = ctx?.conflictStrategy ?? 'conflict-markers';
    if (cs === 'local-win') return deleterIsLocal;
    if (cs === 'remote-win') return !deleterIsLocal;
    if (cs === 'biggest-size') return false;
    const localNewer = this.localWinsByMtime(ctx);
    return deleterIsLocal ? localNewer : !localNewer;
  }

  // Remote wins on a tie.
  private localWinsByMtime(ctx?: MergeContext): boolean {
    return (ctx?.localMtime ?? 0) > (ctx?.remoteMtime ?? 0);
  }

  // Key presence is decided against base so a one-sided deletion propagates instead of the other side's
  // value resurrecting it; delete-vs-modify goes to deletionWins.
  private buildMergedObject(
    base: Record<string, unknown>,
    local: Record<string, unknown>,
    remote: Record<string, unknown>,
    ctx?: MergeContext,
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    const has = (o: Record<string, unknown>, k: string): boolean =>
      Object.prototype.hasOwnProperty.call(o, k);

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

      if (!localHas && !remoteHas) continue;

      if (!localHas) {
        if (!inBase) { merged[k] = remoteVal; continue; }
        if (this.deepEqual(remoteVal, baseVal)) continue;
        if (this.deletionWins(true, ctx)) continue;
        merged[k] = remoteVal;
        continue;
      }
      if (!remoteHas) {
        if (!inBase) { merged[k] = localVal; continue; }
        if (this.deepEqual(localVal, baseVal)) continue;
        if (this.deletionWins(false, ctx)) continue;
        merged[k] = localVal;
        continue;
      }

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
