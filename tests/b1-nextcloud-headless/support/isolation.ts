// Per-run isolated remote workspace: a unique folder under SYNC_FOLDER, removed in teardown.
import { IWebDAVClient } from '../../../src/network/IWebDAVClient';

export interface IsolatedWorkspace {
  name: string;
  remoteBase: string;
}

function joinRemote(a: string, b: string): string {
  const left = (a ?? '').replace(/\/+$/, '');
  const right = (b ?? '').replace(/^\/+/, '');
  if (!left) return right;
  if (!right) return left;
  return `${left}/${right}`;
}

export function makeIsolatedWorkspace(syncFolder: string): IsolatedWorkspace {
  const rand = Math.random().toString(36).slice(2, 8);
  const name = `e2e-${Date.now()}-${rand}`;
  return { name, remoteBase: joinRemote(syncFolder, name) };
}

// WebDAV DELETE on a collection recurses; a 404 counts as success.
export async function cleanupWorkspace(client: IWebDAVClient, ws: IsolatedWorkspace): Promise<void> {
  try {
    await client.deleteFile('', '');
  } catch (err) {
    // eslint-disable-next-line no-console -- surface leftover folder for manual cleanup
    console.warn(`[e2e] cleanup failed for "${ws.name}" (${ws.remoteBase}); delete it manually. Cause:`, err);
  }
}
