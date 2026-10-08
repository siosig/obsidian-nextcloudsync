// 3-actor test fabric: Desktop device (D), Mobile device (M) and the Nextcloud server filesystem (N, changed directly
// + `occ files:scan`). D and M are full SyncEngine devices sharing one workspace; N mutates the server FS out-of-band.
// Cluster-only (N needs the nc-fsops sidecar).
import { LiveEnv } from './env';
import { makeDevice, Device } from './engineDevice';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { NextcloudFs } from './nextcloudFs';
import { decodeBuf } from './helpers';
import { DavSyncSettings } from '../../../src/types';

export type ActorName = 'D' | 'M' | 'N';

export interface Actor {
  name: ActorName;
  // Devices stage locally; N applies on the server immediately.
  put(path: string, content: string): Promise<void>;
  del(path: string): Promise<void>;
  // No-op for N (its change is applied and scanned immediately).
  sync(): Promise<void>;
  // Device local vault, or the WebDAV/server view for N.
  read(path: string): Promise<string | null>;
}

export interface ThreeActors {
  D: Actor & { device: Device };
  M: Actor & { device: Device };
  N: Actor;
  remoteRead(path: string): Promise<string | null>;
  converge(rounds?: number): Promise<void>;
  readAll(path: string): Promise<{ D: string | null; M: string | null; N: string | null }>;
}

export function makeThreeActors(
  env: LiveEnv, remoteBase: string, suffix: string, over: Partial<DavSyncSettings> = {},
): ThreeActors {
  const d = makeDevice(env, remoteBase, `D-${suffix}`, over);
  const m = makeDevice(env, remoteBase, `M-${suffix}`, over);
  const nfs = new NextcloudFs(remoteBase);
  const viewClient = new NextcloudClient(
    { ...d.settings } as DavSyncSettings, env.appPassword, remoteBase,
  );
  let viewConnected = false;

  const remoteRead = async (path: string): Promise<string | null> => {
    if (!viewConnected) { await viewClient.connect(); viewConnected = true; }
    try {
      return decodeBuf(await viewClient.downloadFile(path));
    } catch {
      return null; // 404 / absent
    }
  };

  const deviceActor = (dev: Device, name: 'D' | 'M'): Actor & { device: Device } => ({
    name,
    device: dev,
    async put(path, content) { dev.vault.seedLocal(path, content); },
    async del(path) { dev.vault.deleteLocalTree(path); },
    async sync() { await dev.sync(); },
    async read(path) { return dev.vault.readLocal(path); },
  });

  const nActor: Actor = {
    name: 'N',
    async put(path, content) { nfs.write(path, content); },
    async del(path) { nfs.remove(path); },
    async sync() { /* applied + scanned on write/remove */ },
    async read(path) { return remoteRead(path); },
  };

  const D = deviceActor(d, 'D');
  const M = deviceActor(m, 'M');

  return {
    D, M, N: nActor,
    remoteRead,
    async converge(rounds = 2) {
      for (let i = 0; i < rounds; i++) { await d.sync(); await m.sync(); }
    },
    async readAll(path) {
      return { D: await D.read(path), M: await M.read(path), N: await remoteRead(path) };
    },
  };
}

export const ACTORS: ActorName[] = ['D', 'M', 'N'];

// A conflict pair is resolved by one device (`local`, the last to sync) against the other side's version already on
// the server (`remote`). N can only be remote (no sync engine). For D<->M, D pushes first and M resolves.
export interface PairCfg { key: 'DM' | 'DN' | 'MN'; local: 'D' | 'M'; remote: ActorName; }
export const PAIR_CFGS: PairCfg[] = [
  { key: 'DM', local: 'M', remote: 'D' },
  { key: 'DN', local: 'D', remote: 'N' },
  { key: 'MN', local: 'M', remote: 'N' },
];

// Establishes `base` everywhere, has the remote actor write `remoteContent`, stages `localContent` on the local device
// and syncs it; returns the resolved content the local device (and converged server) now hold.
export async function runDivergentEdit(
  a: ThreeActors, cfg: PairCfg,
  opts: { path: string; base: string | null; localContent: string | null; remoteContent: string | null },
): Promise<{ localView: string | null; remoteView: string | null }> {
  const local = a[cfg.local] as Actor & { device: Device };
  const remote = a[cfg.remote];

  // Common base on all three (skipped for a create-create case when base is null).
  if (opts.base !== null) {
    await a.D.put(opts.path, opts.base);
    await a.converge(3);
  }

  if (opts.remoteContent === null) await remote.del(opts.path);
  else await remote.put(opts.path, opts.remoteContent);
  if ('device' in remote) await (remote as Actor & { device: Device }).device.sync();

  // Stage the local change without syncing yet.
  if (opts.localContent === null) await local.del(opts.path);
  else await local.put(opts.path, opts.localContent);

  await local.device.sync();

  return { localView: await local.read(opts.path), remoteView: await a.remoteRead(opts.path) };
}
