import { DataAdapter, normalizePath } from 'obsidian';
import { SyncFileOp, SyncHistoryEntry } from '../types';
import { ensureParentFolder } from '../util/ensureParentFolder';

export type SyncLogLevel = 'important' | 'all';

/** Per-operation marker glyphs for the sync log (mirrors the status dialog's op→icon map). */
const MARKER: Record<SyncFileOp, string> = {
  uploaded: '↑',
  downloaded: '↓',
  deleted: '🗑',
  merged: '⟷',
  conflicted: '⚠️',
  'local-wins': '⬆',
  'remote-wins': '⬇',
  error: '✗',
};

/** Operations recorded at the "important events only" level. */
const IMPORTANT_OPS: ReadonlySet<SyncFileOp> = new Set<SyncFileOp>([
  'conflicted', 'merged', 'local-wins', 'remote-wins', 'error',
]);

/** Whether an operation is recorded at the given level. */
export function shouldRecord(op: SyncFileOp, level: SyncLogLevel): boolean {
  return level === 'all' || IMPORTANT_OPS.has(op);
}

/** Context stamped onto a session block: timestamp, binary version, conflict-resolution summary. */
export interface SyncLogContext {
  /** Session timestamp (epoch ms). */
  at: number;
  /** Running plugin binary version (e.g. "0.2.10"). */
  version: string;
  /** Pre-formatted conflict-resolution settings summary (see {@link formatResolution}). */
  resolution: string;
  /** Which operations to record. */
  level: SyncLogLevel;
}

/** Short checksum form (first 8 hex chars), or a placeholder when unavailable. */
function shortHash(hash?: string): string {
  return hash && hash.length > 0 ? hash.slice(0, 8) : '-';
}

/** Human-readable byte size (e.g. "1.2KB"), or a placeholder when unavailable. */
export function formatBytes(n?: number): string {
  if (n === undefined || n < 0 || Number.isNaN(n)) return '-';
  if (n < 1024) return `${n}B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(1)}${units[i]}`;
}

/** Remote column: short checksum, annotated with the id type when it is not a content hash. */
function remoteColumn(e: SyncHistoryEntry): string {
  const hash = shortHash(e.remoteId);
  const annotate = e.remoteIdType && e.remoteIdType !== 'sha256' && e.remoteIdType !== 'sha1';
  return annotate ? `${hash}(${e.remoteIdType})` : hash;
}

/** Format all merge-related settings shown in the session header. */
export function formatResolution(opts: {
  failurePolicy: string;
  frontmatterStrategy: string;
  maxConflictRegions: number;
  autoMergeEnabled: boolean;
  mergeableExtensions: string[];
}): string {
  const regions = opts.maxConflictRegions === 0 ? 'unlimited' : String(opts.maxConflictRegions);
  const exts = opts.mergeableExtensions.length > 0 ? opts.mergeableExtensions.join('/') : '(none)';
  return `merge: autoMerge=${opts.autoMergeEnabled ? 'on' : 'off'} `
    + `failure=${opts.failurePolicy} frontmatter=${opts.frontmatterStrategy} `
    + `maxRegions=${regions} mergeable=${exts}`;
}

/**
 * Render one appended session block: a header line carrying the binary version and the
 * conflict-resolution settings, then one line per qualifying operation. Returns `''` when no
 * entry qualifies at the given level (the caller then writes nothing).
 */
export function renderSyncLogBlock(entries: SyncHistoryEntry[], ctx: SyncLogContext): string {
  const qualifying = entries.filter(e => shouldRecord(e.op, ctx.level));
  if (qualifying.length === 0) return '';
  const header = `## Sync ${new Date(ctx.at).toISOString()}  ·  v${ctx.version}  ·  ${ctx.resolution}`;
  const lines = qualifying.map(e =>
    `- ${MARKER[e.op]} \`${e.path}\`  L:${shortHash(e.localHash)}/${formatBytes(e.localSize)}  `
    + `R:${remoteColumn(e)}/${formatBytes(e.remoteSize)}`,
  );
  return [header, ...lines, ''].join('\n');
}

/**
 * Appends a per-device sync-log block at the end of each sync (when enabled and ≥1 entry
 * qualifies). The file is named with this device's host token so devices never overwrite one
 * another. Writing never throws — logging must not break the sync it records.
 */
export class SyncLogWriter {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly isEnabled: () => boolean,
    private readonly pathOf: () => string,
  ) {}

  async append(entries: SyncHistoryEntry[], ctx: SyncLogContext): Promise<void> {
    if (!this.isEnabled()) return;
    const block = renderSyncLogBlock(entries, ctx);
    if (!block) return;
    try {
      const p = normalizePath(this.pathOf());
      if (await this.adapter.exists(p)) {
        await this.adapter.append(p, block);
      } else {
        await ensureParentFolder(this.adapter, p);
        await this.adapter.write(p, `# Nextcloud Sync — sync log\n\n${block}`);
      }
    } catch {
      // Never let sync logging interfere with the sync being logged.
    }
  }
}
