// Per-run isolated remote workspace: a unique folder beneath SYNC_FOLDER that
// every operation is confined to and that is removed during teardown.
import { IWebDAVClient } from '../../../src/network/IWebDAVClient';

export interface IsolatedWorkspace {
  /** Unique folder name; embeds a timestamp to aid manual cleanup on failure. */
  name: string;
  /** serverUrl-relative base folder passed to NextcloudClient as its remoteBase. */
  remoteBase: string;
}

/** Join two remote path segments, trimming stray slashes. */
function joinRemote(a: string, b: string): string {
  const left = (a ?? '').replace(/\/+$/, '');
  const right = (b ?? '').replace(/^\/+/, '');
  if (!left) return right;
  if (!right) return left;
  return `${left}/${right}`;
}

/** Create a unique workspace descriptor under the given SYNC_FOLDER. */
export function makeIsolatedWorkspace(syncFolder: string): IsolatedWorkspace {
  const rand = Math.random().toString(36).slice(2, 8);
  const name = `e2e-${Date.now()}-${rand}`;
  return { name, remoteBase: joinRemote(syncFolder, name) };
}

/**
 * Recursively delete the isolated folder. The client is constructed with the
 * workspace as its remoteBase, so deleting path '' targets the folder itself.
 * WebDAV DELETE on a collection recurses; a 404 is treated as success.
 */
export async function cleanupWorkspace(client: IWebDAVClient, ws: IsolatedWorkspace): Promise<void> {
  try {
    await client.deleteFile('', '');
  } catch (err) {
    // eslint-disable-next-line no-console -- surface leftover folder for manual cleanup
    console.warn(`[e2e] cleanup failed for "${ws.name}" (${ws.remoteBase}); delete it manually. Cause:`, err);
  }
}
