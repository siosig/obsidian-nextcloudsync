// Feature 051: a 3-actor test fabric — Desktop device (D), Mobile device (M), and the Nextcloud
// server filesystem (N, changed directly + `occ files:scan`). D and M are full SyncEngine devices
// sharing one isolated remote workspace; N mutates the server FS out-of-band. Used to sweep the
// create/modify/delete propagation matrix (normal) and the divergent-edit conflict matrix (abnormal)
// across all sync-strategy-relevant combinations. Cluster-only (N needs SSH + occ).
import { LiveEnv } from './env';
import { makeDevice, Device } from './engineDevice';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { NextcloudFs } from './nextcloudFs';
import { decodeBuf } from './helpers';
import { DavSyncSettings } from '../../../src/types';

export type ActorName = 'D' | 'M' | 'N';

export interface Actor {
  name: ActorName;
  /** Create or overwrite a file with `content` (staged locally for a device; applied on the server for N). */
  put(path: string, content: string): Promise<void>;
  /** Delete a file (staged locally for a device; applied on the server for N). */
  del(path: string): Promise<void>;
  /** Push+pull for a device; a no-op for N (its change is applied+scanned immediately). */
  sync(): Promise<void>;
  /** This actor's own view of the file (device local vault, or the WebDAV/server view for N). */
  read(path: string): Promise<string | null>;
}

export interface ThreeActors {
  D: Actor & { device: Device };
  M: Actor & { device: Device };
  N: Actor;
  /** The authoritative server view via WebDAV (null when the path is absent). */
  remoteRead(path: string): Promise<string | null>;
  /** Run D and M syncs for `rounds` bidirectional passes so every actor converges. */
  converge(rounds?: number): Promise<void>;
  /** Read the file as seen by all three actors, for convergence assertions. */
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

/** All three actors, for propagation origins and conflict pairs. */
export const ACTORS: ActorName[] = ['D', 'M', 'N'];

/**
 * A conflict pair, resolved by ONE device (`local`, the last to sync) against the OTHER side's version
 * already on the server (`remote`). N can only be `remote` (it has no sync engine). For D↔M, D pushes
 * first (remote) and M resolves (local).
 */
export interface PairCfg { key: 'DM' | 'DN' | 'MN'; local: 'D' | 'M'; remote: ActorName; }
export const PAIR_CFGS: PairCfg[] = [
  { key: 'DM', local: 'M', remote: 'D' },
  { key: 'DN', local: 'D', remote: 'N' },
  { key: 'MN', local: 'M', remote: 'N' },
];

/**
 * Drive a divergent-edit conflict for one pair: establish `base` everywhere, then the remote actor
 * writes `remoteContent` (pushed to the server) and the local device stages `localContent`, then the
 * local device syncs — surfacing the conflict resolved by the device's strategy. Returns the resolved
 * content as the local device (and the converged server) now hold it.
 */
export async function runDivergentEdit(
  a: ThreeActors, cfg: PairCfg,
  opts: { path: string; base: string | null; localContent: string | null; remoteContent: string | null },
): Promise<{ localView: string | null; remoteView: string | null }> {
  const local = a[cfg.local] as Actor & { device: Device };
  const remote = a[cfg.remote];

  // 1. Establish the common base on all three (skip when base is null → a create-create case).
  if (opts.base !== null) {
    await a.D.put(opts.path, opts.base);
    await a.converge(3);
  }

  // 2. Remote side changes and lands on the server (device: put+sync; N: put+scan).
  if (opts.remoteContent === null) await remote.del(opts.path);
  else await remote.put(opts.path, opts.remoteContent);
  if ('device' in remote) await (remote as Actor & { device: Device }).device.sync();

  // 3. Local device stages its divergent change WITHOUT syncing yet.
  if (opts.localContent === null) await local.del(opts.path);
  else await local.put(opts.path, opts.localContent);

  // 4. Local device syncs → detects both sides changed vs base → resolves per strategy.
  await local.device.sync();

  return { localView: await local.read(opts.path), remoteView: await a.remoteRead(opts.path) };
}
