// The "N" actor: a change made directly on the Nextcloud server filesystem, then made visible to WebDAV via
// `occ files:scan`. In the Docker suite the `nc-fsops` sidecar (sharing the data volume) does it over a JSON HTTP API
// (POST /v1/write, /v1/remove, /v1/scan); its base URL is exported as NEXTCLOUD_FSOPS_URL (e.g. http://nc-fsops:8080).
// The API stays synchronous (curl via execFileSync) so callers need no change. Without the variable N is unavailable
// and the 3-actor suites skip via describeCluster() (support/env.ts).
import { execFileSync } from 'child_process';

function fsopsUrl(): string {
  const v = process.env.NEXTCLOUD_FSOPS_URL;
  if (!v) throw new Error('nextcloudFs: NEXTCLOUD_FSOPS_URL is not set (run via `bash tests/docker/run.sh b1`)');
  return v.replace(/\/$/, '');
}

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

// All paths are relative to the isolated workspace folder; changes land on the server FS and `occ files:scan`
// makes them visible to WebDAV.
export class NextcloudFs {
  constructor(private readonly remoteBase: string) {}

  write(relPath: string, content: string): void {
    fsops('write', {
      base: this.remoteBase,
      path: relPath,
      content_b64: Buffer.from(content, 'utf8').toString('base64'),
    });
    this.scan();
  }

  remove(relPath: string): void {
    fsops('remove', { base: this.remoteBase, path: relPath });
    this.scan();
  }

  scan(): void {
    fsops('scan', { base: this.remoteBase });
  }
}
