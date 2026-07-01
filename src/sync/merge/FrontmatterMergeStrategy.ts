import { load, dump } from 'js-yaml';
import { MergeContext } from '../../types';

export interface FrontmatterMergeResult {
  /** false = caller should fall back to diff3 (YAML parse failure or both sides have no frontmatter) */
  success: boolean;
  /** Resolved frontmatter block including --- delimiters, e.g. "---\ntags:\n  - a\n---" */
  frontmatter: string;
}

/**
 * Semantic union merge for Obsidian frontmatter.
 *
 * Array fields (tags, aliases, related, …) are union-merged with deduplication.
 * Scalar fields resolve via 3-way comparison against the base:
 *   - Only one side changed → that side wins automatically.
 *   - Both sides changed to different values → apply ctx.frontmatterScalarPolicy (or 'remote-win' when ctx absent).
 * Nested YAML objects are treated as opaque scalars (option A from clarification).
 * Falls back (success: false) on YAML parse failure so the caller can use diff3 instead.
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

    const baseData = this.parseFm(baseFm ?? '');
    const localData = this.parseFm(localFm);
    const remoteData = this.parseFm(remoteFm);

    if (localData === null || remoteData === null) {
      return { success: false, frontmatter: '' };
    }

    const base = baseData ?? {};
    const merged = this.buildMergedObject(base, localData, remoteData, ctx);
    const frontmatter = this.serializeFm(merged);
    return { success: true, frontmatter };
  }

  private parseFm(fm: string): Record<string, unknown> | null {
    if (fm === '') return {};
    try {
      // fm is the raw block from splitFrontmatter, e.g. '---\nfoo: bar\n---'
      // Extract the YAML content between the delimiters.
      const match = fm.match(/^---\r?\n([\s\S]*?)\r?\n---$/);
      if (!match) return null;
      const yamlContent = match[1];
      const parsed = load(yamlContent);
      if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private serializeFm(data: Record<string, unknown>): string {
    const yamlContent = dump(data, { lineWidth: -1 }).trimEnd();
    return `---\n${yamlContent}\n---`;
  }

  private isYamlArray(v: unknown): v is unknown[] {
    return Array.isArray(v);
  }

  private unionArrays(a: unknown[], b: unknown[]): unknown[] {
    const seen = new Set<string>();
    const result: unknown[] = [];
    for (const item of [...a, ...b]) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
      }
    }
    return result;
  }

  private deepEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

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

    // Both changed to different values: apply policy
    const policy = ctx?.frontmatterScalarPolicy ?? 'remote-win';
    if (policy === 'local-win') return localVal;
    if (policy === 'remote-win') return remoteVal;
    // 'latest-mtime': newer mtime wins; remote wins on tie
    const localMtime = ctx?.localMtime ?? 0;
    const remoteMtime = ctx?.remoteMtime ?? 0;
    return localMtime > remoteMtime ? localVal : remoteVal;
  }

  private buildMergedObject(
    base: Record<string, unknown>,
    local: Record<string, unknown>,
    remote: Record<string, unknown>,
    ctx?: MergeContext,
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = {};

    // Union of keys: local order first, then remote-only keys appended
    const keys = [...Object.keys(local)];
    for (const k of Object.keys(remote)) {
      if (!keys.includes(k)) keys.push(k);
    }

    for (const k of keys) {
      const baseVal = base[k];
      const localVal = local[k];
      const remoteVal = remote[k];

      if (localVal === undefined) {
        merged[k] = remoteVal;
        continue;
      }
      if (remoteVal === undefined) {
        merged[k] = localVal;
        continue;
      }
      if (this.deepEqual(localVal, remoteVal)) {
        merged[k] = localVal;
        continue;
      }
      if (this.isYamlArray(localVal) && this.isYamlArray(remoteVal)) {
        merged[k] = this.unionArrays(localVal, remoteVal);
        continue;
      }
      merged[k] = this.resolveScalar(baseVal, localVal, remoteVal, ctx);
    }

    return merged;
  }
}
