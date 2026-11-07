// Per-sync coordinator for community plugin bundles: session gate, catalog, bundle directions and restart tracking (docs/spec.md §7).
import type { LocalAdapter } from '../../data/LocalAdapter';
import type { StateDB } from '../../data/StateDB';
import type { IWebDAVClient } from '../../network/IWebDAVClient';
import type { DavSyncSettings, FileState, RemoteFileInfo, SyncStrategy, SyncTrigger } from '../../types';
import type { FileLogger } from '../../util/FileLogger';
import { sha256 } from '../../util/hash';
import { normalizePluginIdList } from '../../util/settingsMigration';
import { remoteIdOf } from '../remoteIdentity';
import {
  decideBundleDirection,
  fileSameContent,
  planBundleFileAction,
  sideChanged,
} from './bundleDirection';
import type { BundleDirection, BundleFileAction, BundleFileState, ManifestSide } from './bundleDirection';
import {
  evaluatePluginCatalogEntry,
  parseCommunityPluginsJson,
  parsePluginManifest,
  shouldFetchRemoteManifest,
} from './pluginCatalog';
import type {
  ManifestRead,
  PluginCatalog,
  PluginIgnoreReason,
  RemoteManifestRead,
} from './pluginCatalog';
import {
  isPluginCodeFile,
  isUnderPluginsDir,
  localWriteMtime,
  parsePluginPath,
  PLUGIN_CODE_FILES,
  pluginDirPath,
} from './pluginPaths';
import type { PluginBundleFile } from './pluginPaths';
import { pluginsNeedingRestart, staleTrackedPluginIds } from './restart';

const PREPARE_CONCURRENCY = 4;
const RESTART_NOTICE_MS = 15000;
const IGNORED_NOTICE_MS = 8000;

export interface PluginPathGate {
  isPluginFileIncluded(id: string, file: PluginBundleFile): boolean;
  includedPluginIds(): readonly string[];
}

export interface LocalWritePort {
  mtimeFor(path: string, remoteMtime: number | undefined): number | undefined;
  written(path: string): void;
}

export interface PluginSessionOutcome {
  pluginsNeedingRestart: string[];
  invalidateRootEtag: boolean;
  ignored: ReadonlyMap<string, PluginIgnoreReason>;
}

export interface PluginSessionPort {
  // `trigger` decides whether the "code file over the size limit" notice is shown (manual) or only logged (automatic).
  begin(trigger: SyncTrigger): void;
  prepare(client: IWebDAVClient, remoteFiles: readonly RemoteFileInfo[]): Promise<void>;
  finish(): PluginSessionOutcome;
  discard(): void;
}

export type PluginConflictRule =
  | { kind: 'force'; action: 'prefer-local' | 'prefer-remote' | 'safe-hold' }
  | { kind: 'strategy'; strategy: Exclude<SyncStrategy, 'merge'> };

export interface PluginSyncCoordinatorOptions {
  configDir: string;
  ownId: string;
  settings: Pick<
    DavSyncSettings,
    'syncConfigFolder' | 'syncedCommunityPlugins' | 'maxFileSizeMB' | 'otherFileStrategy'
  >;
  localAdapter: Pick<LocalAdapter, 'read' | 'readBinary' | 'stat' | 'exists'>;
  stateDB: Pick<StateDB, 'getFile' | 'getAllFiles' | 'getAllDirs'>;
  awaitingRestart: Set<string>;
  obsidianVersion: string;
  isMobile(): boolean;
  now(): number;
  notify(message: string, timeout?: number): void;
  logger?: Pick<FileLogger, 'log'>;
}

interface PluginSessionState {
  readonly trigger: SyncTrigger;
  readonly listed: readonly string[];
  catalog: PluginCatalog | null;
  directions: Map<string, BundleDirection>;
  // Enabled plugins whose code arrives in this sync: their data.json stays out of it (the old code is still running).
  dataJsonHeld: Set<string>;
  codeWritten: Set<string>;
  notified: { tooLarge: boolean; minAppVersion: boolean };
  restartPendingAtPrepare: readonly string[];
}

interface LocalManifest {
  read: ManifestRead;
  hash: string | null;
  stat: { size: number; mtime: number } | null;
}

interface PluginEvaluation {
  id: string;
  reason: PluginIgnoreReason | null;
  direction: BundleDirection;
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function versionOf(read: ManifestRead | RemoteManifestRead): string | null {
  return typeof read === 'object' ? read.version : null;
}

function isEnabled(enabled: PluginCatalog['enabled'], id: string): boolean {
  return enabled === 'unknown' || enabled.has(id);
}

function isTemporarilyUnavailable(reason: PluginIgnoreReason | undefined): boolean {
  return reason === 'remote-manifest-unavailable' || reason === 'local-manifest-unavailable';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PluginSyncCoordinator implements PluginPathGate, LocalWritePort, PluginSessionPort {
  private session: PluginSessionState | null = null;

  constructor(private readonly opts: PluginSyncCoordinatorOptions) {}

  begin(trigger: SyncTrigger): void {
    if (this.session !== null) this.log('plugins: begin() while a session is open; the previous session is discarded');
    const { settings, ownId } = this.opts;
    this.session = {
      trigger,
      listed: settings.syncConfigFolder ? normalizePluginIdList(settings.syncedCommunityPlugins, ownId) : [],
      catalog: null,
      directions: new Map(),
      dataJsonHeld: new Set(),
      codeWritten: new Set(),
      notified: { tooLarge: false, minAppVersion: false },
      restartPendingAtPrepare: [],
    };
  }

  async prepare(client: IWebDAVClient, remoteFiles: readonly RemoteFileInfo[]): Promise<void> {
    const session = this.session;
    if (session === null) return;
    if (session.listed.length === 0) {
      session.catalog = { included: new Set(), ignored: new Map(), enabled: 'unknown' };
      session.directions = new Map();
      return;
    }
    const enabled = parseCommunityPluginsJson(await this.readCommunityPlugins());
    const remoteByPath = new Map(remoteFiles.map((file) => [file.path, file] as const));
    const included = new Set<string>();
    const ignored = new Map<string, PluginIgnoreReason>();
    const directions = new Map<string, BundleDirection>();
    for (const chunk of chunked(session.listed, PREPARE_CONCURRENCY)) {
      const results = await Promise.all(chunk.map((id) => this.evaluatePlugin(id, client, remoteByPath)));
      for (const result of results) {
        if (result.reason !== null) ignored.set(result.id, result.reason);
        else {
          included.add(result.id);
          directions.set(result.id, result.direction);
        }
      }
    }
    session.catalog = { included, ignored, enabled };
    session.directions = directions;
    session.dataJsonHeld = new Set(
      [...directions].filter(([id, direction]) => direction === 'remote' && isEnabled(enabled, id)).map(([id]) => id),
    );
    session.restartPendingAtPrepare = session.listed.filter((id) => this.opts.awaitingRestart.has(id));
    this.log(this.summaryLine(included, ignored, directions));
  }

  isPluginFileIncluded(id: string, file: PluginBundleFile): boolean {
    const catalog = this.session?.catalog ?? null;
    if (catalog === null || !catalog.included.has(id)) return false;
    if (file !== 'data.json') return true;
    return !this.opts.awaitingRestart.has(id) && !(this.session?.dataJsonHeld.has(id) ?? false);
  }

  includedPluginIds(): readonly string[] {
    const catalog = this.session?.catalog ?? null;
    return catalog === null ? [] : [...catalog.included].sort();
  }

  directionFor(id: string): BundleDirection {
    return this.session?.directions.get(id) ?? null;
  }

  fileAction(path: string, state: BundleFileState): BundleFileAction | null {
    const ref = parsePluginPath(path, this.opts.configDir);
    if (ref === null || !isPluginCodeFile(ref.file)) return null;
    return planBundleFileAction(this.directionFor(ref.id), state);
  }

  conflictRuleFor(path: string): PluginConflictRule | null {
    const ref = parsePluginPath(path, this.opts.configDir);
    if (ref === null) return null;
    if (ref.file === 'data.json') return { kind: 'strategy', strategy: this.opts.settings.otherFileStrategy };
    switch (this.directionFor(ref.id)) {
      case 'remote':
        return { kind: 'force', action: 'prefer-remote' };
      case 'local':
        return { kind: 'force', action: 'prefer-local' };
      case 'hold':
        return { kind: 'force', action: 'safe-hold' };
      default:
        return { kind: 'strategy', strategy: 'latest-mtime' };
    }
  }

  staleTrackedIds(): string[] {
    const catalog = this.session?.catalog ?? null;
    if (catalog === null) return [];
    const { stateDB, configDir } = this.opts;
    const paths = [...stateDB.getAllFiles(), ...stateDB.getAllDirs()].map((entry) => entry.path);
    return staleTrackedPluginIds(
      paths,
      configDir,
      (id) => catalog.included.has(id) || isTemporarilyUnavailable(catalog.ignored.get(id)),
    );
  }

  isPluginPath(path: string): boolean {
    return isUnderPluginsDir(path, this.opts.configDir);
  }

  mtimeFor(path: string, remoteMtime: number | undefined): number | undefined {
    return localWriteMtime(path, remoteMtime, this.opts.configDir, this.opts.now());
  }

  written(path: string): void {
    const ref = parsePluginPath(path, this.opts.configDir);
    if (ref === null || !isPluginCodeFile(ref.file)) return;
    if (this.session !== null) {
      this.session.codeWritten.add(ref.id);
      return;
    }
    this.opts.awaitingRestart.add(ref.id);
    this.notifyRestart([ref.id]);
  }

  finish(): PluginSessionOutcome {
    const session = this.session;
    if (session === null) return { pluginsNeedingRestart: [], invalidateRootEtag: false, ignored: new Map() };
    try {
      return this.buildOutcome(session);
    } catch (error) {
      this.log(`plugins: finish failed: ${errorText(error)}`);
      return { pluginsNeedingRestart: [], invalidateRootEtag: true, ignored: new Map() };
    } finally {
      this.session = null;
    }
  }

  discard(): void {
    this.session = null;
  }

  private buildOutcome(session: PluginSessionState): PluginSessionOutcome {
    const catalog = session.catalog;
    const needs = pluginsNeedingRestart(session.codeWritten, catalog?.enabled ?? 'unknown');
    for (const id of needs) this.opts.awaitingRestart.add(id);
    if (needs.length > 0) this.notifyRestart(needs);
    const ignored = catalog?.ignored ?? new Map<string, PluginIgnoreReason>();
    this.notifyIgnored(session, ignored);
    return {
      pluginsNeedingRestart: needs,
      invalidateRootEtag:
        ignored.size > 0 || session.restartPendingAtPrepare.length > 0 || session.dataJsonHeld.size > 0,
      ignored,
    };
  }

  private notifyIgnored(session: PluginSessionState, ignored: ReadonlyMap<string, PluginIgnoreReason>): void {
    const idsOf = (reason: PluginIgnoreReason): string[] =>
      [...ignored].filter(([, r]) => r === reason).map(([id]) => id).sort();
    const tooLarge = idsOf('too-large');
    if (tooLarge.length > 0 && !session.notified.tooLarge) {
      session.notified.tooLarge = true;
      // Shown on manual syncs only; an automatic sync just logs it (docs/spec.md §9.4a). Either way it is not in the
      // skipped-file count.
      if (session.trigger === 'manual') {
        this.safeNotify(
          `⚠️ Not syncing community plugins with a code file over the size limit: ${tooLarge.join(', ')}.`,
          IGNORED_NOTICE_MS,
        );
      } else {
        this.log(`plugins: size-limit notice suppressed (automatic sync): ${tooLarge.join(', ')}`);
      }
    }
    const tooNew = idsOf('min-app-version');
    if (tooNew.length > 0 && !session.notified.minAppVersion) {
      session.notified.minAppVersion = true;
      this.safeNotify(
        `⚠️ Not syncing community plugins that need a newer Obsidian: ${tooNew.join(', ')}.`,
        IGNORED_NOTICE_MS,
      );
    }
  }

  private notifyRestart(ids: readonly string[]): void {
    this.safeNotify(
      `⚠️ Restart Obsidian to load the updated code of: ${ids.join(', ')}. Until then their settings (data.json) are not synced.`,
      RESTART_NOTICE_MS,
    );
  }

  private safeNotify(message: string, timeout: number): void {
    try {
      this.opts.notify(message, timeout);
    } catch (error) {
      this.log(`plugins: notification failed: ${errorText(error)}`);
    }
  }

  private log(message: string): void {
    try {
      void Promise.resolve(this.opts.logger?.log(message)).catch(() => undefined);
    } catch {
      // Logging must never affect a sync.
    }
  }

  private summaryLine(
    included: ReadonlySet<string>,
    ignored: ReadonlyMap<string, PluginIgnoreReason>,
    directions: ReadonlyMap<string, BundleDirection>,
  ): string {
    const includedText = [...included].sort().join(',');
    const ignoredText = [...ignored].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, r]) => `${id}:${r}`).join(',');
    const directionText = [...directions].sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, d]) => `${id}:${d ?? 'none'}`).join(',');
    return `plugins: included=[${includedText}] ignored=[${ignoredText}] directions=[${directionText}]`;
  }

  // Missing file or any read error yields null, which parses to 'unknown' (every plugin counts as enabled).
  private async readCommunityPlugins(): Promise<string | null> {
    const path = `${this.opts.configDir}/community-plugins.json`;
    try {
      return (await this.opts.localAdapter.exists(path)) ? await this.opts.localAdapter.read(path) : null;
    } catch {
      return null;
    }
  }

  private async evaluatePlugin(
    id: string,
    client: IWebDAVClient,
    remoteByPath: ReadonlyMap<string, RemoteFileInfo>,
  ): Promise<PluginEvaluation> {
    const manifestPath = `${pluginDirPath(id, this.opts.configDir)}/manifest.json`;
    let local: LocalManifest;
    try {
      local = await this.readLocalManifest(manifestPath);
    } catch (error) {
      this.log(`plugins: local manifest read failed for ${manifestPath}: ${errorText(error)}`);
      return { id, reason: 'local-manifest-unavailable', direction: null };
    }
    const remoteInfo = remoteByPath.get(manifestPath) ?? null;
    const base = this.opts.stateDB.getFile(manifestPath) ?? null;
    const remote = await this.readRemoteManifest(client, remoteInfo, local.hash, base);
    const reason = evaluatePluginCatalogEntry({
      local: local.read,
      remote,
      codeFileSizes: await this.codeFileSizes(id, local.stat, remoteByPath),
      isMobile: this.opts.isMobile(),
      obsidianVersion: this.opts.obsidianVersion,
      maxFileSizeMB: this.opts.settings.maxFileSizeMB,
    });
    if (reason !== null) return { id, reason, direction: null };
    return { id, reason: null, direction: this.decideDirection(local, remote, remoteInfo, base) };
  }

  private async readLocalManifest(path: string): Promise<LocalManifest> {
    const stat = await this.opts.localAdapter.stat(path);
    if (stat === null) return { read: 'absent', hash: null, stat: null };
    const bytes = await this.opts.localAdapter.readBinary(path);
    const hash = await sha256(bytes);
    const info = parsePluginManifest(new TextDecoder().decode(bytes));
    return { read: info ?? 'unreadable', hash, stat };
  }

  private async readRemoteManifest(
    client: IWebDAVClient,
    remoteInfo: RemoteFileInfo | null,
    localHash: string | null,
    base: FileState | null,
  ): Promise<RemoteManifestRead> {
    if (remoteInfo === null) return 'absent';
    if (!shouldFetchRemoteManifest({ remoteManifest: remoteInfo, localHash, base })) return 'not-fetched';
    try {
      const bytes = await client.downloadFile(remoteInfo.path);
      return parsePluginManifest(new TextDecoder().decode(bytes)) ?? 'unreadable';
    } catch (error) {
      this.log(`plugins: remote manifest fetch failed for ${remoteInfo.path}: ${errorText(error)}`);
      return 'fetch-failed';
    }
  }

  // Sizes of the code files from both the local stat and the remote listing; missing files are left out.
  private async codeFileSizes(
    id: string,
    manifestStat: { size: number } | null,
    remoteByPath: ReadonlyMap<string, RemoteFileInfo>,
  ): Promise<number[]> {
    const sizes: number[] = [];
    for (const file of PLUGIN_CODE_FILES) {
      const path = `${pluginDirPath(id, this.opts.configDir)}/${file}`;
      const stat = file === 'manifest.json' ? manifestStat : await this.opts.localAdapter.stat(path);
      if (stat !== null) sizes.push(stat.size);
      const remoteSize = remoteByPath.get(path)?.size;
      if (remoteSize !== undefined) sizes.push(remoteSize);
    }
    return sizes;
  }

  private decideDirection(
    local: LocalManifest,
    remote: RemoteManifestRead,
    remoteInfo: RemoteFileInfo | null,
    base: FileState | null,
  ): BundleDirection {
    const localChanged = sideChanged(local.stat !== null, local.hash, base?.localHash ?? null);
    const remoteId = remoteInfo === null ? null : remoteIdOf(remoteInfo).remoteId;
    const remoteChanged = sideChanged(remoteInfo !== null, remoteId, base?.remoteId ?? null);
    const localSide: ManifestSide | null =
      local.stat === null ? null : { version: versionOf(local.read), mtime: local.stat.mtime };
    const remoteSide: ManifestSide | null =
      remoteInfo === null ? null : { version: versionOf(remote), mtime: remoteInfo.lastModified };
    return decideBundleDirection({
      local: localSide,
      remote: remoteSide,
      localChanged,
      remoteChanged,
      sameContent: fileSameContent({ localHash: local.hash, remote: remoteInfo, base, localChanged }),
    });
  }
}
