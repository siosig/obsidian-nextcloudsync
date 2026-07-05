// Feature 051: the "N" actor — a change made DIRECTLY on the Nextcloud server's filesystem (as if by
// another tool), then made visible to WebDAV via `occ files:scan`. Only meaningful against the
// ephemeral cluster (nextcloud-cloudrun), which exposes SSH + a host bind-mounted data dir + an `occ`
// wrapper. The cluster runner (scripts/b1-cluster.sh) exports the connection details as env vars:
//   NEXTCLOUD_SSH_TARGET  e.g. runner@34.146.46.66
//   NEXTCLOUD_DATA_HOST   e.g. /opt/svc-node/data
//   NEXTCLOUD_USER        e.g. admin
// When they are absent (localhost / plain b1), N is unavailable and the 3-actor tests skip cleanly.
import { execFileSync } from 'child_process';

export function nextcloudFsAvailable(): boolean {
  return !!(process.env.NEXTCLOUD_SSH_TARGET && process.env.NEXTCLOUD_DATA_HOST && process.env.NEXTCLOUD_USER);
}

/**
 * Fail loudly (never silently pass) when the N actor is unavailable. The 3-actor tests are
 * cluster-only and meaningless without N; a silent early-return would fake a green run. Call this at
 * the top of every 3-actor test so a run that does NOT exercise N fails with an actionable message.
 * Run against the ephemeral cluster: `pnpm test:b1:cluster` (after `make up` in nextcloud-cloudrun).
 */
export function assertNextcloudFs(): void {
  if (!nextcloudFsAvailable()) {
    throw new Error(
      'N actor (Nextcloud server FS) unavailable: NEXTCLOUD_SSH_TARGET/DATA_HOST/USER are unset. '
      + 'The 3-actor tests require the ephemeral cluster — run `pnpm test:b1:cluster` '
      + '(scripts/b1-cluster.sh) against nextcloud-cloudrun, not a plain/localhost b1 run.',
    );
  }
}

function req(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`nextcloudFs: ${key} is not set (run via scripts/b1-cluster.sh against the cluster)`);
  return v;
}

/** Run one command on the cluster VM over SSH (batch mode, no host-key checks). */
function ssh(command: string): string {
  // Ephemeral cluster VMs reuse external IPs, so a cached (now-stale) host key would otherwise make
  // ssh refuse with "offending key". Disable host-key checking entirely (throwaway test VM).
  return execFileSync(
    'ssh',
    [
      '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
      req('NEXTCLOUD_SSH_TARGET'), command,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
}

/**
 * The N actor scoped to one isolated workspace folder (`remoteBase`, e.g. `e2e-<id>`). All paths are
 * relative to that folder. Writes go to the host bind-mounted data dir (owned by www-data uid 33) and
 * are picked up by `occ files:scan` so the WebDAV layer (and thus the plugin devices) see them.
 */
export class NextcloudFs {
  constructor(private readonly remoteBase: string) {}

  private user(): string { return req('NEXTCLOUD_USER'); }
  private baseDir(): string { return `${req('NEXTCLOUD_DATA_HOST')}/${this.user()}/files/${this.remoteBase}`; }
  private scanTarget(): string { return `${this.user()}/files/${this.remoteBase}`; }

  /** Create or overwrite a file directly on the server FS, then rescan so WebDAV sees it. */
  write(relPath: string, content: string): void {
    const abs = `${this.baseDir()}/${relPath}`;
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    // base64 avoids all shell-quoting hazards for the file content; chown -R keeps the whole workspace
    // owned by www-data so occ can read it.
    ssh(
      `sudo mkdir -p "$(dirname '${abs}')" && ` +
      `printf '%s' '${b64}' | base64 -d | sudo tee '${abs}' >/dev/null && ` +
      `sudo chown -R 33:33 '${this.baseDir()}'`,
    );
    this.scan();
  }

  /** Delete a file or folder directly on the server FS, then rescan. */
  remove(relPath: string): void {
    ssh(`sudo rm -rf '${this.baseDir()}/${relPath}'`);
    this.scan();
  }

  /** Force Nextcloud to re-index this workspace so direct-FS changes become visible to WebDAV. */
  scan(): void {
    ssh(`occ files:scan --path='${this.scanTarget()}' 2>/dev/null || occ files:scan --path='${this.scanTarget()}'`);
  }
}
