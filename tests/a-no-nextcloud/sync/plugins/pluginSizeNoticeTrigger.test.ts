import { PluginSyncCoordinator } from '../../../../src/sync/plugins/PluginSyncCoordinator';
import type { PluginSyncCoordinatorOptions } from '../../../../src/sync/plugins/PluginSyncCoordinator';
import type { IWebDAVClient } from '../../../../src/network/IWebDAVClient';
import type { FileState, RemoteFileInfo, SyncTrigger } from '../../../../src/types';

// ---- PluginSyncCoordinator fixtures (copied from pluginCatalog.test.ts, plus a capturing logger) ----

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
const toBuffer = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

function makeEnv(init: EnvInit = {}) {
  const local = new Map(Object.entries(init.local ?? {}));
  const remote = new Map(Object.entries(init.remote ?? {}));
  const tracked = init.tracked ?? [];
  const awaitingRestart = new Set(init.awaiting ?? []);
  const logs: string[] = [];
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
    logger: { log: jest.fn(async (m: string) => { logs.push(m); }) },
  } satisfies CoordOpts);
  return { coordinator, client, notify, remoteFiles, logs };
}

// ---- docs/spec.md §9.4a: the community-plugin size notice depends on the sync trigger ----------------

const TRIGGERS: readonly SyncTrigger[] = ['manual', 'automatic'];
const FLAGS: readonly boolean[] = [true, false];

// Cartesian product of trigger x tooLarge x tooNew.
const COMBINATIONS: Array<[SyncTrigger, boolean, boolean]> = TRIGGERS.flatMap((trigger) =>
  FLAGS.flatMap((tooLarge) => FLAGS.map((tooNew): [SyncTrigger, boolean, boolean] => [trigger, tooLarge, tooNew])),
);

const SIZE_NOTICE = '⚠️ Not syncing community plugins with a code file over the size limit: big.';
const SIZE_NOTICE_MS = 8000;
const SUPPRESSED_LOG = 'plugins: size-limit notice suppressed (automatic sync): big';

describe('[SPEC:OSN-13] community plugin size notice by sync trigger', () => {
  it.each(COMBINATIONS)(
    'trigger=%s tooLarge=%s tooNew=%s',
    async (trigger, tooLarge, tooNew) => {
      const env = makeEnv({
        listed: [...(tooLarge ? ['big'] : []), ...(tooNew ? ['old'] : [])],
        maxFileSizeMB: tooLarge ? 1 : 50,
        remote: tooLarge
          ? { [pluginFile('big', 'main.js')]: { content: 'x', size: 2 * 1024 * 1024, mtime: 1_000 } }
          : {},
        local: tooNew
          ? {
            [pluginFile('old', 'manifest.json')]: {
              content: JSON.stringify({ version: '1.0.0', minAppVersion: '9.0.0' }),
              mtime: 1_000,
            },
          }
          : {},
      });

      env.coordinator.begin(trigger);
      await env.coordinator.prepare(env.client, env.remoteFiles);
      env.coordinator.finish();

      const calls = env.notify.mock.calls as unknown[][];
      const sizeNotices = calls.filter((c) => String(c[0]).includes('over the size limit'));
      const tooNewNotices = calls.filter((c) => String(c[0]).includes('need a newer Obsidian: old'));
      const suppressedLogs = env.logs.filter((l) => l.includes('plugins: size-limit notice suppressed'));

      // Size notice: a manual sync shows it once; an automatic sync shows nothing and logs one line.
      expect(sizeNotices).toEqual(tooLarge && trigger === 'manual' ? [[SIZE_NOTICE, SIZE_NOTICE_MS]] : []);
      expect(suppressedLogs).toEqual(tooLarge && trigger === 'automatic' ? [SUPPRESSED_LOG] : []);

      // The newer-Obsidian notice does not depend on the trigger.
      expect(tooNewNotices).toHaveLength(tooNew ? 1 : 0);

      // Nothing else is announced: no restart notice, no duplicate notice.
      expect(env.notify).toHaveBeenCalledTimes(sizeNotices.length + tooNewNotices.length);
    },
  );
});
