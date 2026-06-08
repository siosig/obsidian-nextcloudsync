import { RemoteFileInfo, ConflictError } from '../types';
import { StateDB } from '../data/StateDB';
import { IWebDAVClient } from '../network/IWebDAVClient';

export class RenameTracker {
  constructor(
    private readonly stateDB: StateDB,
    private readonly client: IWebDAVClient,
  ) {}

  /**
   * Detect remote renames by matching oc:fileid.
   * Returns a map of oldPath → newPath for paths that were renamed on the server.
   */
  detectRemoteRenames(remoteFiles: RemoteFileInfo[]): Map<string, string> {
    const renames = new Map<string, string>();
    for (const remote of remoteFiles) {
      if (!remote.fileId) continue;
      const existing = this.stateDB.getFileByRemoteId(remote.fileId);
      if (existing && existing.path !== remote.path) {
        renames.set(existing.path, remote.path);
      }
    }
    return renames;
  }

  /**
   * Detect local renames by hash+size matching (fallback when oc:fileid unavailable).
   * Compares files deleted from StateDB with files newly added locally.
   */
  detectLocalRenamesByHash(
    deletedPaths: string[],
    addedLocalFiles: Map<string, { hash: string; size: number }>,
  ): Map<string, string> {
    const renames = new Map<string, string>();
    for (const deletedPath of deletedPaths) {
      const base = this.stateDB.getFile(deletedPath);
      if (!base) continue;
      for (const [newPath, localInfo] of addedLocalFiles) {
        if (localInfo.hash === base.localHash && localInfo.size === base.size) {
          renames.set(deletedPath, newPath);
          break;
        }
      }
    }
    return renames;
  }

  /** Apply a remote rename to local Vault and update StateDB. */
  async applyRemoteRename(oldPath: string, newPath: string): Promise<void> {
    const file = this.stateDB.getFile(oldPath);
    if (!file) return;
    this.stateDB.deleteFile(oldPath);
    this.stateDB.setFile({ ...file, path: newPath });
    console.log(`[RenameTracker] Renamed (remote→local): ${oldPath} → ${newPath}`);
  }

  /** Issue a WebDAV MOVE for a locally-renamed file. Falls back to conflict on 412. */
  async applyLocalRename(oldRemotePath: string, newRemotePath: string): Promise<void> {
    try {
      await this.client.moveFile(oldRemotePath, newRemotePath);
      const file = this.stateDB.getFile(oldRemotePath);
      if (file) {
        this.stateDB.deleteFile(oldRemotePath);
        this.stateDB.setFile({ ...file, path: newRemotePath });
      }
    } catch (err) {
      if (err instanceof ConflictError) {
        console.warn(`[RenameTracker] Rename conflict: ${newRemotePath} already exists on server (skipped).`);
      } else {
        throw err;
      }
    }
  }
}
