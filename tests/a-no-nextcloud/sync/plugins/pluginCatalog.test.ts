import { PluginSyncCoordinator } from '../../../../src/sync/plugins/PluginSyncCoordinator';
import type { PluginSyncCoordinatorOptions } from '../../../../src/sync/plugins/PluginSyncCoordinator';
import { isUnderPluginsDir } from '../../../../src/sync/plugins/pluginPaths';
import type { IWebDAVClient } from '../../../../src/network/IWebDAVClient';
import {
  parsePluginManifest,
  parseCommunityPluginsJson,
  evaluatePluginCatalogEntry,
  shouldFetchRemoteManifest,
} from '../../../../src/sync/plugins/pluginCatalog';
import type { CatalogEntryInput, PluginManifestInfo } from '../../../../src/sync/plugins/pluginCatalog';
import type { FileState, RemoteFileInfo } from '../../../../src/types';

const MB = 1024 * 1024;

function manifest(over: Partial<PluginManifestInfo> = {}): PluginManifestInfo {
  return { name: 'Foo', version: '1.0.0', minAppVersion: null, isDesktopOnly: false, ...over };
}

function entry(over: Partial<CatalogEntryInput> = {}): CatalogEntryInput {
  return {
    local: manifest(), remote: manifest(), codeFileSizes: [100, 200, 300],
    isMobile: false, obsidianVersion: '1.13.7', maxFileSizeMB: 50, ...over,
  };
}

function remoteInfo(over: Partial<RemoteFileInfo> = {}): RemoteFileInfo {
  return {
    path: '.obsidian/plugins/foo/manifest.json', fileId: 'fid', checksum: null, etag: 'etag-new',
    size: 10, lastModified: 1_000, ...over,
  };
}

function baseState(over: Partial<FileState> = {}): FileState {
  return {
    path: '.obsidian/plugins/foo/manifest.json', localHash: 'lh', remoteId: 'etag-old', idType: 'etag',
    size: 10, mtime: 100, remoteFileId: 'fid', isConflicted: false, ...over,
  };
}

describe('[SPEC:CPS-8] plugin catalog', () => {
  describe('parsePluginManifest', () => {
    it.each(['{', '[]', 'null', '1'])('returns null for %j', (raw) => {
      expect(parsePluginManifest(raw)).toBeNull();
    });

    it('returns all-null fields and isDesktopOnly false for an empty object', () => {
      expect(parsePluginManifest('{}')).toEqual({
        name: null, version: null, minAppVersion: null, isDesktopOnly: false,
      });
    });

    it('takes only string fields, and isDesktopOnly only when strictly true', () => {
      const raw = '{"name":1,"version":"1.0.0","minAppVersion":"1.5.0","isDesktopOnly":"true"}';
      expect(parsePluginManifest(raw)).toEqual({
        name: null, version: '1.0.0', minAppVersion: '1.5.0', isDesktopOnly: false,
      });
      expect(parsePluginManifest('{"name":"A","isDesktopOnly":true}')?.isDesktopOnly).toBe(true);
    });
  });

  describe('evaluatePluginCatalogEntry', () => {
    it('returns null for a plain desktop entry', () => {
      expect(evaluatePluginCatalogEntry(entry())).toBeNull();
    });

    it('row 1: a failed remote manifest fetch is unavailable and wins over row 2', () => {
      expect(evaluatePluginCatalogEntry(entry({ remote: 'fetch-failed' }))).toBe('remote-manifest-unavailable');
      expect(evaluatePluginCatalogEntry(entry({ remote: 'fetch-failed', codeFileSizes: [100 * MB] })))
        .toBe('remote-manifest-unavailable');
    });

    it('row 2: any code file over the limit is too large, and wins over row 3', () => {
      expect(evaluatePluginCatalogEntry(entry({ codeFileSizes: [100, 51 * MB] }))).toBe('too-large');
      expect(evaluatePluginCatalogEntry(entry({
        codeFileSizes: [51 * MB], isMobile: true, local: manifest({ isDesktopOnly: true }),
      }))).toBe('too-large');
    });

    it('does not ignore a large plugin when maxFileSizeMB is 0', () => {
      expect(evaluatePluginCatalogEntry(entry({ codeFileSizes: [900 * MB], maxFileSizeMB: 0 }))).toBeNull();
    });

    it('row 3: desktop-only on mobile, from either manifest', () => {
      expect(evaluatePluginCatalogEntry(entry({ isMobile: true, local: manifest({ isDesktopOnly: true }) })))
        .toBe('desktop-only');
      expect(evaluatePluginCatalogEntry(entry({ isMobile: true, remote: manifest({ isDesktopOnly: true }) })))
        .toBe('desktop-only');
      expect(evaluatePluginCatalogEntry(entry({
        isMobile: true, local: 'absent', remote: manifest({ isDesktopOnly: true }),
      }))).toBe('desktop-only');
    });

    it('does not ignore a desktop-only plugin on the desktop', () => {
      expect(evaluatePluginCatalogEntry(entry({ local: manifest({ isDesktopOnly: true }) }))).toBeNull();
    });

    it('row 3 wins over row 5', () => {
      expect(evaluatePluginCatalogEntry(entry({
        isMobile: true, local: manifest({ isDesktopOnly: true, minAppVersion: '9.0.0' }),
      }))).toBe('desktop-only');
    });

    it('row 4: on mobile, no readable manifest and an unreadable one is manifest-unreadable', () => {
      expect(evaluatePluginCatalogEntry(entry({ isMobile: true, local: 'unreadable', remote: 'absent' })))
        .toBe('manifest-unreadable');
      expect(evaluatePluginCatalogEntry(entry({ isMobile: true, local: 'absent', remote: 'unreadable' })))
        .toBe('manifest-unreadable');
      expect(evaluatePluginCatalogEntry(entry({ isMobile: true, local: 'unreadable', remote: 'unreadable' })))
        .toBe('manifest-unreadable');
    });

    it('row 4 does not apply when the other manifest is readable', () => {
      expect(evaluatePluginCatalogEntry(entry({ isMobile: true, local: 'unreadable', remote: manifest() }))).toBeNull();
    });

    it('does not ignore an unreadable manifest on the desktop', () => {
      expect(evaluatePluginCatalogEntry(entry({ local: 'unreadable', remote: 'unreadable' }))).toBeNull();
    });

    it.each([
      ['absent', 'absent'],
      ['absent', 'not-fetched'],
    ] as const)('does not ignore a plugin with no manifest (%s, %s)', (local, remote) => {
      expect(evaluatePluginCatalogEntry(entry({ local, remote }))).toBeNull();
      expect(evaluatePluginCatalogEntry(entry({ local, remote, isMobile: true }))).toBeNull();
    });

    it('row 5: a manifest needing a newer Obsidian is min-app-version, from either side', () => {
      expect(evaluatePluginCatalogEntry(entry({ local: manifest({ minAppVersion: '1.14.0' }) }))).toBe('min-app-version');
      expect(evaluatePluginCatalogEntry(entry({ remote: manifest({ minAppVersion: '2.0.0' }) }))).toBe('min-app-version');
    });

    it.each(['1.13.7', '1.5.0', null, 'abc'])('does not ignore minAppVersion %j', (minAppVersion) => {
      expect(evaluatePluginCatalogEntry(entry({ local: manifest({ minAppVersion }) }))).toBeNull();
    });

    it('row 5: a two-element minAppVersion is compared with the missing parts as 0', () => {
      expect(evaluatePluginCatalogEntry(entry({ local: manifest({ minAppVersion: '1.14' }) }))).toBe('min-app-version');
      expect(evaluatePluginCatalogEntry(entry({ remote: manifest({ minAppVersion: '2' }) }))).toBe('min-app-version');
      expect(evaluatePluginCatalogEntry(entry({ local: manifest({ minAppVersion: '1.13' }) }))).toBeNull();
      expect(evaluatePluginCatalogEntry(entry({ local: manifest({ minAppVersion: '1' }) }))).toBeNull();
    });
  });

  describe('shouldFetchRemoteManifest', () => {
    it('is true when the remote differs from the base and nothing proves identity', () => {
      expect(shouldFetchRemoteManifest({ remoteManifest: remoteInfo(), localHash: 'lh', base: baseState() })).toBe(true);
    });

    it('is true when there is no local file', () => {
      expect(shouldFetchRemoteManifest({ remoteManifest: remoteInfo(), localHash: null, base: baseState() })).toBe(true);
    });

    it('is true when there is no base', () => {
      expect(shouldFetchRemoteManifest({ remoteManifest: remoteInfo(), localHash: 'lh', base: null })).toBe(true);
    });

    it('is false without a remote manifest', () => {
      expect(shouldFetchRemoteManifest({ remoteManifest: null, localHash: null, base: null })).toBe(false);
    });

    it('is false when the checksum proves the local file identical', () => {
      expect(shouldFetchRemoteManifest({
        remoteManifest: remoteInfo({ checksum: 'lh' }), localHash: 'lh', base: baseState(),
      })).toBe(false);
    });

    it('is false when the remote id equals the base remote id', () => {
      expect(shouldFetchRemoteManifest({
        remoteManifest: remoteInfo({ etag: 'etag-old' }), localHash: 'lh', base: baseState({ remoteId: 'etag-old' }),
      })).toBe(false);
    });
  });
});

describe('[SPEC:CPS-9] community-plugins.json', () => {
  it.each([null, '{', '{}', '"a"'])('parseCommunityPluginsJson(%j) is unknown', (raw) => {
    expect(parseCommunityPluginsJson(raw)).toBe('unknown');
  });

  it('keeps only string elements', () => {
    expect(parseCommunityPluginsJson('["a", 1, "b"]')).toEqual(new Set(['a', 'b']));
  });

  it('parses an empty array to an empty set', () => {
    const result = parseCommunityPluginsJson('[]');
    expect(result).toEqual(new Set());
    expect(result).not.toBe('unknown');
  });
});

// ---- PluginSyncCoordinator fixtures -------------------------------------------------------------

const CFG = '.obsidian';
type CoordOpts = PluginSyncCoordinatorOptions;

interface FakeFile { content: string; mtime: number; size?: number }

interface EnvInit {
  listed?: string[];
  syncConfigFolder?: boolean;
  local?: Record<string, FakeFile>;
  remote?: Record<string, FakeFile>;
  tracked?: FileState[];
  awaiting?: string[];
  maxFileSizeMB?: number;
  isMobile?: boolean;
  obsidianVersion?: string;
  otherFileStrategy?: CoordOpts['settings']['otherFileStrategy'];
}

const pluginFile = (id: string, file: string): string => `${CFG}/plugins/${id}/${file}`;
const manifestJson = (version: string, name = 'Plugin'): string => JSON.stringify({ name, version });
const toBuffer = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

function makeEnv(init: EnvInit = {}) {
  const local = new Map(Object.entries(init.local ?? {}));
  const remote = new Map(Object.entries(init.remote ?? {}));
  const tracked = init.tracked ?? [];
  const awaitingRestart = new Set(init.awaiting ?? []);
  const localAdapter = {
    read: jest.fn(async (path: string): Promise<string> => {
      const file = local.get(path);
      if (!file) throw new Error(`ENOENT: ${path}`);
      return file.content;
    }),
    readBinary: jest.fn(async (path: string): Promise<ArrayBuffer> => {
      const file = local.get(path);
      if (!file) throw new Error(`ENOENT: ${path}`);
      return toBuffer(file.content);
    }),
    stat: jest.fn(async (path: string) => {
      const file = local.get(path);
      return file ? { size: file.size ?? file.content.length, mtime: file.mtime } : null;
    }),
    exists: jest.fn(async (path: string): Promise<boolean> => local.has(path)),
  };
  const stateDB = {
    getFile: jest.fn((path: string) => tracked.find((s) => s.path === path)),
    getAllFiles: jest.fn(() => tracked),
    getAllDirs: jest.fn(() => []),
  };
  const downloadFile = jest.fn(async (remotePath: string): Promise<ArrayBuffer> => {
    for (const [path, file] of remote) {
      if (remotePath.endsWith(path)) return toBuffer(file.content);
    }
    throw new Error(`404: ${remotePath}`);
  });
  const client = { downloadFile } as unknown as IWebDAVClient;
  const notify = jest.fn();
  const remoteFiles: RemoteFileInfo[] = [...remote].map(([path, file]) => ({
    path, fileId: `fid-${path}`, checksum: null, etag: `etag-${file.content}`,
    size: file.size ?? file.content.length, lastModified: file.mtime,
  }));
  const coordinator = new PluginSyncCoordinator({
    configDir: CFG,
    ownId: 'own',
    settings: {
      syncConfigFolder: init.syncConfigFolder ?? true,
      syncedCommunityPlugins: init.listed ?? [],
      maxFileSizeMB: init.maxFileSizeMB ?? 50,
      otherFileStrategy: init.otherFileStrategy ?? 'latest-mtime',
    },
    localAdapter, stateDB, awaitingRestart,
    obsidianVersion: init.obsidianVersion ?? '1.13.7',
    isMobile: () => init.isMobile ?? false,
    now: () => 1_000_000,
    notify,
  } satisfies CoordOpts);
  const ioCalls = (): number => localAdapter.read.mock.calls.length + localAdapter.readBinary.mock.calls.length
    + localAdapter.stat.mock.calls.length + localAdapter.exists.mock.calls.length;
  return { coordinator, client, downloadFile, notify, awaitingRestart, remoteFiles, localAdapter, ioCalls };
}

type Env = ReturnType<typeof makeEnv>;

async function prepared(env: Env): Promise<void> {
  env.coordinator.begin('manual');
  await env.coordinator.prepare(env.client, env.remoteFiles);
}

const BIG = 60 * 1024 * 1024;

describe('[SPEC:CPS-8] PluginSyncCoordinator gate', () => {
  it('is closed before begin(): nothing is included', () => {
    const env = makeEnv({ listed: ['p'] });
    expect(env.coordinator.isPluginFileIncluded('p', 'main.js')).toBe(false);
    expect(env.coordinator.includedPluginIds()).toEqual([]);
  });

  it('is closed after begin() and before prepare()', () => {
    const env = makeEnv({ listed: ['p'] });
    env.coordinator.begin('manual');
    expect(env.coordinator.isPluginFileIncluded('p', 'main.js')).toBe(false);
    expect(env.coordinator.isPluginFileIncluded('p', 'data.json')).toBe(false);
    expect(env.coordinator.includedPluginIds()).toEqual([]);
  });

  it('does no I/O and includes nothing when syncConfigFolder is false', async () => {
    const env = makeEnv({ listed: ['p'], syncConfigFolder: false });
    await prepared(env);
    expect(env.coordinator.includedPluginIds()).toEqual([]);
    expect(env.coordinator.isPluginFileIncluded('p', 'main.js')).toBe(false);
    expect(env.downloadFile).not.toHaveBeenCalled();
    expect(env.localAdapter.read).not.toHaveBeenCalled();
    expect(env.ioCalls()).toBe(0);
  });

  it('does no I/O when the list is empty', async () => {
    const env = makeEnv({ listed: [] });
    await prepared(env);
    expect(env.coordinator.includedPluginIds()).toEqual([]);
    expect(env.downloadFile).not.toHaveBeenCalled();
    expect(env.ioCalls()).toBe(0);
  });

  describe('when prepared', () => {
    async function preparedWithFourRows(): Promise<Env> {
      const env = makeEnv({
        listed: ['own', 'big', 'ok', 'rs'],
        local: { [pluginFile('big', 'main.js')]: { content: 'x', size: BIG, mtime: 1_000 } },
        awaiting: ['rs'],
      });
      await prepared(env);
      return env;
    }

    it('excludes an id that is not in the list', async () => {
      const env = await preparedWithFourRows();
      expect(env.coordinator.isPluginFileIncluded('other', 'main.js')).toBe(false);
      expect(env.coordinator.isPluginFileIncluded('other', 'data.json')).toBe(false);
    });

    it('excludes an ignored id', async () => {
      const env = await preparedWithFourRows();
      expect(env.coordinator.isPluginFileIncluded('big', 'main.js')).toBe(false);
      expect(env.coordinator.isPluginFileIncluded('big', 'data.json')).toBe(false);
    });

    it('excludes only data.json of an id awaiting a restart', async () => {
      const env = await preparedWithFourRows();
      expect(env.coordinator.isPluginFileIncluded('rs', 'data.json')).toBe(false);
      expect(env.coordinator.isPluginFileIncluded('rs', 'main.js')).toBe(true);
    });

    it('includes every file of any other listed id', async () => {
      const env = await preparedWithFourRows();
      for (const file of ['manifest.json', 'main.js', 'styles.css', 'data.json'] as const) {
        expect(env.coordinator.isPluginFileIncluded('ok', file)).toBe(true);
      }
    });

    it('never includes the plugin\'s own id even if it is in the list', async () => {
      const env = await preparedWithFourRows();
      expect(env.coordinator.isPluginFileIncluded('own', 'main.js')).toBe(false);
      expect(env.coordinator.includedPluginIds()).toEqual(['ok', 'rs']);
    });
  });

  it('closes the gate again after finish()', async () => {
    const env = makeEnv({ listed: ['p'] });
    await prepared(env);
    expect(env.coordinator.isPluginFileIncluded('p', 'main.js')).toBe(true);
    env.coordinator.finish();
    expect(env.coordinator.isPluginFileIncluded('p', 'main.js')).toBe(false);
    expect(env.coordinator.includedPluginIds()).toEqual([]);
  });

  it('closes the gate again after discard()', async () => {
    const env = makeEnv({ listed: ['p'] });
    await prepared(env);
    env.coordinator.discard();
    expect(env.coordinator.isPluginFileIncluded('p', 'main.js')).toBe(false);
    expect(env.coordinator.includedPluginIds()).toEqual([]);
  });
});

describe('[SPEC:CPS-5] PluginSyncCoordinator directions', () => {
  const localNewer = {
    local: { [pluginFile('p', 'manifest.json')]: { content: manifestJson('1.1.0'), mtime: 5_000 } },
    remote: { [pluginFile('p', 'manifest.json')]: { content: manifestJson('1.0.0'), mtime: 5_000 } },
  };

  it('prefers the side with the newer version and uploads its code files', async () => {
    const env = makeEnv({ listed: ['p'], ...localNewer });
    await prepared(env);
    expect(env.coordinator.directionFor('p')).toBe('local');
    expect(env.coordinator.fileAction(pluginFile('p', 'main.js'), {
      localPresent: true, remotePresent: true, tracked: false, sameContent: false,
    })).toBe('upload');
  });

  it('returns null from fileAction for data.json and for a note path', async () => {
    const env = makeEnv({ listed: ['p'], ...localNewer });
    await prepared(env);
    const state = { localPresent: true, remotePresent: true, tracked: false, sameContent: false };
    expect(env.coordinator.fileAction(pluginFile('p', 'data.json'), state)).toBeNull();
    expect(env.coordinator.fileAction('notes/a.md', state)).toBeNull();
  });

  it('returns null from directionFor outside the session, before prepare and for an unlisted id', async () => {
    const env = makeEnv({ listed: ['p'], ...localNewer });
    expect(env.coordinator.directionFor('p')).toBeNull();
    env.coordinator.begin('manual');
    expect(env.coordinator.directionFor('p')).toBeNull();
    await env.coordinator.prepare(env.client, env.remoteFiles);
    expect(env.coordinator.directionFor('p')).toBe('local');
    expect(env.coordinator.directionFor('unlisted')).toBeNull();
    env.coordinator.finish();
    expect(env.coordinator.directionFor('p')).toBeNull();
  });

  describe('conflictRuleFor', () => {
    async function withAllDirections(): Promise<Env> {
      const env = makeEnv({
        listed: ['loc', 'rem', 'held', 'none'],
        otherFileStrategy: 'remote-win',
        local: {
          [pluginFile('loc', 'manifest.json')]: { content: manifestJson('2.0.0'), mtime: 5_000 },
          [pluginFile('rem', 'manifest.json')]: { content: manifestJson('1.0.0'), mtime: 5_000 },
          [pluginFile('held', 'manifest.json')]: { content: manifestJson('1.0.0', 'Local'), mtime: 5_000 },
        },
        remote: {
          [pluginFile('loc', 'manifest.json')]: { content: manifestJson('1.0.0'), mtime: 5_000 },
          [pluginFile('rem', 'manifest.json')]: { content: manifestJson('2.0.0'), mtime: 5_000 },
          [pluginFile('held', 'manifest.json')]: { content: manifestJson('1.0.0', 'Remote'), mtime: 5_000 },
        },
      });
      await prepared(env);
      return env;
    }

    it('forces prefer-remote when the direction is remote', async () => {
      const env = await withAllDirections();
      expect(env.coordinator.conflictRuleFor(pluginFile('rem', 'main.js'))).toEqual({ kind: 'force', action: 'prefer-remote' });
    });

    it('forces prefer-local when the direction is local', async () => {
      const env = await withAllDirections();
      expect(env.coordinator.conflictRuleFor(pluginFile('loc', 'styles.css'))).toEqual({ kind: 'force', action: 'prefer-local' });
    });

    it('forces safe-hold when the direction is hold', async () => {
      const env = await withAllDirections();
      expect(env.coordinator.conflictRuleFor(pluginFile('held', 'manifest.json'))).toEqual({ kind: 'force', action: 'safe-hold' });
    });

    it('falls back to latest-mtime for a code file without a direction', async () => {
      const env = await withAllDirections();
      expect(env.coordinator.directionFor('none')).toBeNull();
      expect(env.coordinator.conflictRuleFor(pluginFile('none', 'main.js'))).toEqual({ kind: 'strategy', strategy: 'latest-mtime' });
    });

    it('uses otherFileStrategy for data.json', async () => {
      const env = await withAllDirections();
      expect(env.coordinator.conflictRuleFor(pluginFile('loc', 'data.json'))).toEqual({ kind: 'strategy', strategy: 'remote-win' });
    });

    it('returns null for a note', async () => {
      const env = await withAllDirections();
      expect(env.coordinator.conflictRuleFor('notes/a.md')).toBeNull();
    });
  });

  describe('isPluginPath', () => {
    it.each([
      '.obsidian/plugins', '.obsidian/plugins/p/main.js', '.obsidian/plugins/p', '.obsidian/pluginsx/a.js',
      '.obsidian/themes/t.css', 'notes/a.md', 'plugins/p/main.js',
    ])('matches isUnderPluginsDir for %s', (path) => {
      const env = makeEnv();
      expect(env.coordinator.isPluginPath(path)).toBe(isUnderPluginsDir(path, CFG));
    });
  });

  it('staleTrackedIds reports a tracked plugin that is no longer in the list', async () => {
    const env = makeEnv({
      listed: ['p'],
      tracked: [{
        path: pluginFile('gone', 'main.js'), localHash: 'lh', remoteId: 'r', idType: 'etag',
        size: 1, mtime: 1, remoteFileId: 'fid', isConflicted: false,
      }],
    });
    await prepared(env);
    expect(env.coordinator.staleTrackedIds()).toEqual(['gone']);
  });
});

describe('[SPEC:CPS-8] PluginSyncCoordinator catalog', () => {
  const MIB = 1024 * 1024;
  const manifestPath = (id: string): string => pluginFile(id, 'manifest.json');
  const localManifest = (id: string, content: string): Record<string, FakeFile> =>
    ({ [manifestPath(id)]: { content, mtime: 1_000 } });
  const sizeNotices = (env: Env): unknown[][] =>
    env.notify.mock.calls.filter((c) => String(c[0]).includes('over the size limit'));

  it('ignores a desktop-only plugin on mobile: gate closed, reason desktop-only, no notice', async () => {
    const env = makeEnv({
      listed: ['p'], isMobile: true,
      local: localManifest('p', JSON.stringify({ version: '1.0.0', isDesktopOnly: true })),
    });
    await prepared(env);
    expect(env.coordinator.isPluginFileIncluded('p', 'main.js')).toBe(false);
    expect(env.coordinator.includedPluginIds()).toEqual([]);
    expect(env.coordinator.finish().ignored.get('p')).toBe('desktop-only');
    expect(env.notify).not.toHaveBeenCalled();
  });

  it('ignores a plugin whose remote code file is over the limit and notifies once, ids sorted', async () => {
    const env = makeEnv({
      listed: ['b', 'a'], maxFileSizeMB: 1,
      remote: {
        [pluginFile('b', 'main.js')]: { content: 'x', size: 2 * MIB, mtime: 1_000 },
        [pluginFile('a', 'main.js')]: { content: 'x', size: 2 * MIB, mtime: 1_000 },
      },
    });
    await prepared(env);
    expect(env.coordinator.isPluginFileIncluded('a', 'main.js')).toBe(false);
    const out = env.coordinator.finish();
    expect(out.ignored.get('a')).toBe('too-large');
    expect(out.ignored.get('b')).toBe('too-large');
    expect(sizeNotices(env)).toEqual([[
      '\u26A0\uFE0F Not syncing community plugins with a code file over the size limit: a, b.', 8000,
    ]]);
    expect(env.notify).toHaveBeenCalledTimes(1);
  });

  it('ignores a plugin that needs a newer Obsidian and notifies once', async () => {
    const env = makeEnv({
      listed: ['p'], obsidianVersion: '1.13.7',
      local: localManifest('p', JSON.stringify({ version: '1.0.0', minAppVersion: '9.0.0' })),
    });
    await prepared(env);
    expect(env.coordinator.isPluginFileIncluded('p', 'main.js')).toBe(false);
    expect(env.coordinator.finish().ignored.get('p')).toBe('min-app-version');
    expect(env.notify).toHaveBeenCalledTimes(1);
    expect(String(env.notify.mock.calls[0][0])).toContain('need a newer Obsidian: p');
  });

  it('ignores an unreadable manifest on mobile without a notice', async () => {
    const env = makeEnv({ listed: ['p'], isMobile: true, local: localManifest('p', '{') });
    await prepared(env);
    expect(env.coordinator.isPluginFileIncluded('p', 'main.js')).toBe(false);
    expect(env.coordinator.finish().ignored.get('p')).toBe('manifest-unreadable');
    expect(env.notify).not.toHaveBeenCalled();
  });

  it('treats a failed remote manifest fetch as temporary: no notice, not stale, root ETag invalidated', async () => {
    const env = makeEnv({
      listed: ['p'],
      remote: { [manifestPath('p')]: { content: manifestJson('1.0.0'), mtime: 1_000 } },
      tracked: [{
        path: pluginFile('p', 'main.js'), localHash: 'lh', remoteId: 'r', idType: 'etag',
        size: 1, mtime: 1, remoteFileId: 'fid', isConflicted: false,
      }],
    });
    env.downloadFile.mockRejectedValue(new Error('network down'));
    await prepared(env);
    expect(env.coordinator.isPluginFileIncluded('p', 'main.js')).toBe(false);
    expect(env.coordinator.staleTrackedIds()).toEqual([]);
    const out = env.coordinator.finish();
    expect(out.ignored.get('p')).toBe('remote-manifest-unavailable');
    expect(out.invalidateRootEtag).toBe(true);
    expect(env.notify).not.toHaveBeenCalled();
  });

  it('ignores a plugin whose local manifest cannot be read, keeps its tracking, and syncs the others', async () => {
    const env = makeEnv({
      listed: ['bad', 'ok'],
      local: {
        ...localManifest('bad', manifestJson('1.0.0')),
        ...localManifest('ok', manifestJson('1.0.0')),
      },
      tracked: [{
        path: pluginFile('bad', 'main.js'), localHash: 'lh', remoteId: 'r', idType: 'etag',
        size: 1, mtime: 1, remoteFileId: 'fid', isConflicted: false,
      }],
    });
    const readBinary = env.localAdapter.readBinary.getMockImplementation()!;
    env.localAdapter.readBinary.mockImplementation(async (path: string) => {
      if (path === manifestPath('bad')) throw new Error('EACCES');
      return readBinary(path);
    });
    await expect(prepared(env)).resolves.toBeUndefined();
    expect(env.coordinator.isPluginFileIncluded('bad', 'main.js')).toBe(false);
    expect(env.coordinator.isPluginFileIncluded('ok', 'main.js')).toBe(true);
    expect(env.coordinator.staleTrackedIds()).toEqual([]);
    const out = env.coordinator.finish();
    expect(out.ignored.get('bad')).toBe('local-manifest-unavailable');
    expect(out.ignored.has('ok')).toBe(false);
    expect(out.invalidateRootEtag).toBe(true);
    expect(env.notify).not.toHaveBeenCalled();
  });

  it('ignores a plugin whose local manifest stat throws', async () => {
    const env = makeEnv({ listed: ['bad'], local: localManifest('bad', manifestJson('1.0.0')) });
    env.localAdapter.stat.mockRejectedValue(new Error('EIO'));
    await expect(prepared(env)).resolves.toBeUndefined();
    expect(env.coordinator.finish().ignored.get('bad')).toBe('local-manifest-unavailable');
  });

  it('fetches the remote manifest at most once per id in one prepare', async () => {
    const env = makeEnv({
      listed: ['a', 'b'],
      remote: {
        [manifestPath('a')]: { content: manifestJson('1.0.0'), mtime: 1_000 },
        [manifestPath('b')]: { content: manifestJson('1.0.0'), mtime: 1_000 },
      },
    });
    await prepared(env);
    const fetched = env.downloadFile.mock.calls.map((c) => String(c[0]));
    expect(fetched.filter((p) => p.endsWith(manifestPath('a')))).toHaveLength(1);
    expect(fetched.filter((p) => p.endsWith(manifestPath('b')))).toHaveLength(1);
  });

  it('does not fetch the remote manifest when the tracked remote id already matches', async () => {
    const content = manifestJson('1.0.0');
    const env = makeEnv({
      listed: ['p'],
      local: localManifest('p', content),
      remote: { [manifestPath('p')]: { content, mtime: 1_000 } },
      tracked: [{
        path: manifestPath('p'), localHash: 'lh', remoteId: `etag-${content}`, idType: 'etag',
        size: content.length, mtime: 1_000, remoteFileId: 'fid', isConflicted: false,
      }],
    });
    await prepared(env);
    expect(env.downloadFile).not.toHaveBeenCalled();
  });
});
