// Nextcloud version history, lifted out of SyncEngine (feature 074, Phase 5).
//
// Two operations the user invokes from the version-history modal. They touch the server and the
// local file, but they take no part in a sync session: no summary, no history entry, no merge base.
// That is what makes this the smallest and cleanest of the extractions.
//
// Nextcloud-only by construction — both throw FeatureUnsupportedError when the connected server is
// not one, which is also what the modal shows the user.
import { FileVersion, FeatureUnsupportedError, NextcloudFeatures } from '../../types';
import { LocalAdapter } from '../../data/LocalAdapter';
import { StateDB } from '../../data/StateDB';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { withLocalSignature } from '../../data/localSignature';
import { sha256 } from '../../util/hash';

export interface VersionDeps {
  localAdapter: Pick<LocalAdapter, 'stat' | 'atomicWriteBinary'>;
  stateDB: Pick<StateDB, 'getFile' | 'setFile' | 'save'>;
}

export class VersionService {
  constructor(private readonly deps: VersionDeps) {}

  /** Return the version list for the active note. Throws FeatureUnsupportedError if unsupported or fileId is missing. */
  async listVersions(client: IWebDAVClient, features: NextcloudFeatures, path: string): Promise<FileVersion[]> {
    const fileId = this.requireFileId(features, path);
    return client.listVersions(fileId);
  }

  /** Restore the specified version, apply it locally, and update the state DB (FR-007/008). */
  async restoreVersion(
    client: IWebDAVClient, features: NextcloudFeatures, path: string, version: FileVersion,
  ): Promise<void> {
    const fileId = this.requireFileId(features, path);

    // 1. Restore on the server side (MOVE restore).
    await client.restoreVersion(version, fileId);
    // 2. Fetch the current content after restore and atomically apply it locally.
    const data = await client.downloadFile(path);
    await this.deps.localAdapter.atomicWriteBinary(path, data);
    // 3. Update the state DB (localHash=remoteId=hash of restored content, isConflicted=false).
    const localHash = await sha256(data);
    const stat = await this.deps.localAdapter.stat(path);
    this.deps.stateDB.setFile(await withLocalSignature(this.deps.localAdapter, {
      path, localHash, remoteId: localHash, idType: 'sha256',
      size: stat?.size ?? data.byteLength, mtime: stat?.mtime ?? Date.now(),
      remoteFileId: fileId, isConflicted: false,
    }));
    await this.deps.stateDB.save();
  }

  /**
   * The two preconditions both operations share: a Nextcloud server, and a file we have a remote id
   * for. Versions are addressed by fileId, so a file the state DB has never seen has no history to
   * show — indistinguishable, from the caller's side, from the server not supporting versions.
   */
  private requireFileId(features: NextcloudFeatures, path: string): string {
    if (!features.isNextcloud) throw new FeatureUnsupportedError('versions');
    const fileId = this.deps.stateDB.getFile(path)?.remoteFileId;
    if (!fileId) throw new FeatureUnsupportedError('versions');
    return fileId;
  }
}
