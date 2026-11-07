import { PluginSyncCoordinator } from '../../../../src/sync/plugins/PluginSyncCoordinator';
import type { PluginSyncCoordinatorOptions } from '../../../../src/sync/plugins/PluginSyncCoordinator';
import type { IWebDAVClient } from '../../../../src/network/IWebDAVClient';
import type { FileState, RemoteFileInfo } from '../../../../src/types';
import { pluginsNeedingRestart, staleTrackedPluginIds } from '../../../../src/sync/plugins/restart';

describe('[SPEC:CPS-9] restart targets', () => {
  describe('pluginsNeedingRestart', () => {
    it('returns every written plugin, sorted, when community-plugins.json is unknown', () => {
      expect(pluginsNeedingRestart(new Set(['b', 'a']), 'unknown')).toEqual(['a', 'b']);
    });

    it('returns only the enabled plugins otherwise', () => {
      expect(pluginsNeedingRestart(new Set(['b', 'a']), new Set(['a', 'c']))).toEqual(['a']);
    });

    it('returns nothing when no code was written', () => {
      expect(pluginsNeedingRestart(new Set(), 'unknown')).toEqual([]);
      expect(pluginsNeedingRestart(new Set(), new Set(['a']))).toEqual([]);
    });
  });

  describe('staleTrackedPluginIds', () => {
    it('returns the distinct, sorted ids of tracked plugins that are no longer active', () => {
      const tracked = [
        '.obsidian/plugins/x/main.js',
        '.obsidian/plugins/x/data.json',
        '.obsidian/plugins/y/manifest.json',
        '.obsidian/plugins/z',
        '.obsidian/plugins/.bad/main.js',
        'notes/a.md',
      ];
      expect(staleTrackedPluginIds(tracked, '.obsidian', (id) => id === 'y')).toEqual(['x', 'z']);
    });
  });

  describe('the isActive expression the coordinator passes', () => {
    // Mirrors the contract: included ids and ids ignored only for a failed remote manifest fetch stay active.
    const included = new Set(['a']);
    const ignored = new Map<string, string>([['b', 'remote-manifest-unavailable'], ['c', 'too-large']]);
    const isActive = (id: string): boolean => included.has(id) || ignored.get(id) === 'remote-manifest-unavailable';

    it('does not report included or temporarily unavailable plugins as stale', () => {
      const tracked = ['a', 'b', 'c', 'd'].map((id) => `.obsidian/plugins/${id}/main.js`);
      expect(staleTrackedPluginIds(tracked, '.obsidian', isActive)).toEqual(['c', 'd']);
    });
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
    obsidianVersion: '1.13.7',
    isMobile: () => false,
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

describe('[SPEC:CPS-9] PluginSyncCoordinator restart', () => {
  const RESTART_MESSAGE = '⚠️ Restart Obsidian to load the updated code of: p. Until then their settings (data.json) are not synced.';
  const communityPlugins = (ids: string[]): Record<string, FakeFile> => ({
    [`${CFG}/community-plugins.json`]: { content: JSON.stringify(ids), mtime: 1_000 },
  });

  it('reports a plugin whose code was written during the session and notifies once', async () => {
    const env = makeEnv({ listed: ['p'] });
    await prepared(env);
    env.coordinator.written(pluginFile('p', 'main.js'));
    const outcome = env.coordinator.finish();
    expect(outcome.pluginsNeedingRestart).toEqual(['p']);
    expect(env.awaitingRestart.has('p')).toBe(true);
    expect(env.notify).toHaveBeenCalledTimes(1);
    expect(env.notify).toHaveBeenCalledWith(RESTART_MESSAGE, 15000);
  });

  it('reports a plugin that is enabled in community-plugins.json', async () => {
    const env = makeEnv({ listed: ['p'], local: communityPlugins(['p']) });
    await prepared(env);
    env.coordinator.written(pluginFile('p', 'main.js'));
    expect(env.coordinator.finish().pluginsNeedingRestart).toEqual(['p']);
  });

  it('reports nothing when the written plugin is not enabled', async () => {
    const env = makeEnv({ listed: ['p'], local: communityPlugins(['q']) });
    await prepared(env);
    env.coordinator.written(pluginFile('p', 'main.js'));
    expect(env.coordinator.finish().pluginsNeedingRestart).toEqual([]);
    expect(env.notify).not.toHaveBeenCalled();
    expect(env.awaitingRestart.size).toBe(0);
  });

  it('treats a missing community-plugins.json as unknown and reports the written plugin', async () => {
    const env = makeEnv({ listed: ['p'] });
    await prepared(env);
    env.coordinator.written(pluginFile('p', 'styles.css'));
    expect(env.coordinator.finish().pluginsNeedingRestart).toEqual(['p']);
  });

  it('ignores a written data.json', async () => {
    const env = makeEnv({ listed: ['p'] });
    await prepared(env);
    env.coordinator.written(pluginFile('p', 'data.json'));
    expect(env.coordinator.finish().pluginsNeedingRestart).toEqual([]);
    expect(env.notify).not.toHaveBeenCalled();
    expect(env.awaitingRestart.size).toBe(0);
  });

  it('marks the plugin and notifies once when code is written outside a session', () => {
    const env = makeEnv({ listed: ['p'] });
    env.coordinator.written(pluginFile('p', 'main.js'));
    expect(env.awaitingRestart.has('p')).toBe(true);
    expect(env.notify).toHaveBeenCalledTimes(1);
    expect(env.notify).toHaveBeenCalledWith(RESTART_MESSAGE, 15000);
  });

  it('invalidates the root etag when a listed id was awaiting a restart at prepare()', async () => {
    const env = makeEnv({ listed: ['p'], awaiting: ['p'] });
    await prepared(env);
    expect(env.coordinator.finish().invalidateRootEtag).toBe(true);
  });

  it('invalidates the root etag when a listed id is ignored', async () => {
    const env = makeEnv({
      listed: ['big'],
      local: { [pluginFile('big', 'main.js')]: { content: 'x', size: BIG, mtime: 1_000 } },
    });
    await prepared(env);
    const outcome = env.coordinator.finish();
    expect(outcome.invalidateRootEtag).toBe(true);
    expect(outcome.ignored.get('big')).toBe('too-large');
  });

  it('does not invalidate the root etag with nothing ignored and nothing awaiting a restart', async () => {
    const env = makeEnv({ listed: ['p'] });
    await prepared(env);
    expect(env.coordinator.finish().invalidateRootEtag).toBe(false);
  });

  it('returns an empty outcome when the session is closed', () => {
    const env = makeEnv({ listed: ['p'] });
    const outcome = env.coordinator.finish();
    expect(outcome).toEqual(expect.objectContaining({ pluginsNeedingRestart: [], invalidateRootEtag: false }));
    expect(outcome.ignored.size).toBe(0);
    expect(env.notify).not.toHaveBeenCalled();
  });

  describe('data.json in the sync that delivers the code', () => {
    const remoteOnly = (): Record<string, FakeFile> => ({
      [pluginFile('p', 'manifest.json')]: { content: manifestJson('2.0.0'), mtime: 2_000 },
    });

    it.each([
      ['community-plugins.json is missing', undefined],
      ['the plugin is enabled', communityPlugins(['p'])],
    ])('holds data.json for a plugin whose code comes from the remote when %s', async (_name, local) => {
      const env = makeEnv({ listed: ['p'], remote: remoteOnly(), local });
      await prepared(env);
      expect(env.coordinator.directionFor('p')).toBe('remote');
      expect(env.coordinator.isPluginFileIncluded('p', 'data.json')).toBe(false);
      expect(env.coordinator.isPluginFileIncluded('p', 'main.js')).toBe(true);
      expect(env.coordinator.isPluginFileIncluded('p', 'manifest.json')).toBe(true);
    });

    it('still syncs data.json for a plugin that is not enabled', async () => {
      const env = makeEnv({ listed: ['p'], remote: remoteOnly(), local: communityPlugins(['q']) });
      await prepared(env);
      expect(env.coordinator.directionFor('p')).toBe('remote');
      expect(env.coordinator.isPluginFileIncluded('p', 'data.json')).toBe(true);
      expect(env.coordinator.finish().invalidateRootEtag).toBe(false);
    });

    it('still syncs data.json when the code direction is not remote', async () => {
      const env = makeEnv({
        listed: ['p'], local: { ...communityPlugins(['p']), [pluginFile('p', 'manifest.json')]: { content: manifestJson('2.0.0'), mtime: 2_000 } },
      });
      await prepared(env);
      expect(env.coordinator.directionFor('p')).toBe('local');
      expect(env.coordinator.isPluginFileIncluded('p', 'data.json')).toBe(true);
    });

    it('invalidates the root etag so the next sync is not short-circuited', async () => {
      const env = makeEnv({ listed: ['p'], remote: remoteOnly(), local: communityPlugins(['p']) });
      await prepared(env);
      expect(env.coordinator.finish().invalidateRootEtag).toBe(true);
    });
  });

  describe('mtimeFor', () => {
    it('returns the current time for a plugin data.json', () => {
      const env = makeEnv();
      expect(env.coordinator.mtimeFor(pluginFile('p', 'data.json'), 5)).toBe(1_000_000);
    });

    it('returns the remote mtime for any other path', () => {
      const env = makeEnv();
      expect(env.coordinator.mtimeFor('a.md', 5)).toBe(5);
    });
  });
});
