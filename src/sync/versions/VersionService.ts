// Nextcloud-only: both operations throw FeatureUnsupportedError on other servers (the modal shows it).
// They take no part in a sync session: no summary, no history entry, no merge base.
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

  async listVersions(client: IWebDAVClient, features: NextcloudFeatures, path: string): Promise<FileVersion[]> {
    const fileId = this.requireFileId(features, path);
    return client.listVersions(fileId);
  }

  async restoreVersion(
    client: IWebDAVClient, features: NextcloudFeatures, path: string, version: FileVersion,
  ): Promise<void> {
    const fileId = this.requireFileId(features, path);

    await client.restoreVersion(version, fileId);
    const data = await client.downloadFile(path);
    await this.deps.localAdapter.atomicWriteBinary(path, data);
    // Both hashes are the restored content's hash.
    const localHash = await sha256(data);
    const stat = await this.deps.localAdapter.stat(path);
    this.deps.stateDB.setFile(await withLocalSignature(this.deps.localAdapter, {
      path, localHash, remoteId: localHash, idType: 'sha256',
      size: stat?.size ?? data.byteLength, mtime: stat?.mtime ?? Date.now(),
      remoteFileId: fileId, isConflicted: false,
    }));
    await this.deps.stateDB.save();
  }

  // Versions are addressed by fileId, so a file the state DB has never seen has no history to show.
  private requireFileId(features: NextcloudFeatures, path: string): string {
    if (!features.isNextcloud) throw new FeatureUnsupportedError('versions');
    const fileId = this.deps.stateDB.getFile(path)?.remoteFileId;
    if (!fileId) throw new FeatureUnsupportedError('versions');
    return fileId;
  }
}
