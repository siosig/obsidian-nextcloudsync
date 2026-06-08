import { NextcloudFeatures, RemoteFileInfo, SyncChanges, FileVersion } from '../types';

export interface IWebDAVClient {
  connect(): Promise<NextcloudFeatures>;
  getFiles(path: string): Promise<RemoteFileInfo[]>;
  getChanges(syncToken: string): Promise<SyncChanges>;
  downloadFile(remotePath: string, localTmpPath: string): Promise<void>;
  uploadFile(remotePath: string, data: ArrayBuffer): Promise<void>;
  moveFile(oldPath: string, newPath: string): Promise<void>;
  deleteFile(path: string, expectedRemoteId: string): Promise<void>;
  getSyncToken(): Promise<string | null>;
  /** Returns the ArrayBuffer from the most recent downloadFile() call. */
  getLastDownloadBuffer(): ArrayBuffer;

  // ── US2: バージョン履歴（非対応クライアントは FeatureUnsupportedError）──
  /** fileId のバージョン一覧を新しい順で返す。 */
  listVersions(fileId: string): Promise<FileVersion[]>;
  /** version の内容を取得する。 */
  getVersionContent(version: FileVersion, fileId: string): Promise<ArrayBuffer>;
  /** version をサーバー側の現行ファイルに復元する（MOVE restore）。 */
  restoreVersion(version: FileVersion, fileId: string): Promise<void>;

  // ── US3: チャンクアップロード ──
  /** data をチャンク分割してアップロードする。完了で最終パスに原子的に出現する。 */
  uploadChunked(remotePath: string, data: ArrayBuffer, chunkSizeBytes: number): Promise<void>;

  // ── US4: Files Locking ──
  /** ファイルロックを取得しトークンを返す。HTTP 423 は FileLockedError。 */
  lockFile(remotePath: string): Promise<string>;
  /** トークンでロックを解放する（ベストエフォート・失敗しても例外を投げない）。 */
  unlockFile(remotePath: string, token: string): Promise<void>;
}
