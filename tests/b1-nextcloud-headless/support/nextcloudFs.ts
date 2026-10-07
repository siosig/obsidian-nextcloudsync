// Feature 051: the "N" actor — a change made DIRECTLY on the Nextcloud server's filesystem (as if by
// another tool), then made visible to WebDAV via `occ files:scan`. In the Docker suite this is done
// by the `nc-fsops` sidecar, which shares the Nextcloud data volume and exposes a small JSON HTTP API
// (POST /v1/write, /v1/remove, /v1/scan). The runner exports its base URL as:
//   NEXTCLOUD_FSOPS_URL   e.g. http://nc-fsops:8080  (reachable only inside the run network)
// The API stays synchronous (curl via execFileSync) so callers need no change.
// When the variable is absent, N is unavailable and the 3-actor suites skip cleanly via
// describeCluster() (see support/env.ts); `bash tests/docker/run.sh b1` provides it.
import { execFileSync } from 'child_process';

function fsopsUrl(): string {
  const v = process.env.NEXTCLOUD_FSOPS_URL;
  if (!v) throw new Error('nextcloudFs: NEXTCLOUD_FSOPS_URL is not set (run via `bash tests/docker/run.sh b1`)');
  return v.replace(/\/$/, '');
}

/** POST one JSON request to the fsops sidecar; throws with curl's stderr on any failure. */
function fsops(op: 'write' | 'remove' | 'scan', body: Record<string, string>): void {
  try {
    execFileSync(
      'curl',
      [
        '-fsS', '-X', 'POST', '--data-binary', '@-',
        '-H', 'Content-Type: application/json',
        `${fsopsUrl()}/v1/${op}`,
      ],
      { input: JSON.stringify(body), encoding: 'utf8', timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const detail = (err.stderr ? String(err.stderr) : err.message ?? String(e)).trim();
    throw new Error(`fsops ${op} failed: ${detail}`);
  }
}

/**
 * The N actor scoped to one isolated workspace folder (`remoteBase`, e.g. `e2e-<id>`). All paths are
 * relative to that folder. Changes are applied on the server FS by nc-fsops and picked up by
 * `occ files:scan` so the WebDAV layer (and thus the plugin devices) see them.
 */
export class NextcloudFs {
  constructor(private readonly remoteBase: string) {}

  /** Create or overwrite a file directly on the server FS, then rescan so WebDAV sees it. */
  write(relPath: string, content: string): void {
    fsops('write', {
      base: this.remoteBase,
      path: relPath,
      content_b64: Buffer.from(content, 'utf8').toString('base64'),
    });
    this.scan();
  }

  /** Delete a file or folder directly on the server FS, then rescan. */
  remove(relPath: string): void {
    fsops('remove', { base: this.remoteBase, path: relPath });
    this.scan();
  }

  /** Force Nextcloud to re-index this workspace so direct-FS changes become visible to WebDAV. */
  scan(): void {
    fsops('scan', { base: this.remoteBase });
  }
}
