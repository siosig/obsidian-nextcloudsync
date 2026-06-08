import { NextcloudFeatures, RemoteFileInfo, SyncChanges } from '../types';

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
}
