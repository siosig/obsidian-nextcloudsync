import { Notice } from 'obsidian';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { IUploadStrategy, UploadConfig, UploadOutcome, UploadOptions } from './IUploadStrategy';
import { isOverFileSizeLimit } from '../../util/limits';

/** Strategy that always sends via a single PUT (standard WebDAV / default fallback). */
export class SimpleUploadStrategy implements IUploadStrategy {
  constructor(private readonly config: UploadConfig) {}

  async upload(client: IWebDAVClient, remotePath: string, data: ArrayBuffer, mtime?: number, opts?: UploadOptions): Promise<UploadOutcome> {
    // Skipping large files guards mobile memory (OOM). maxFileSizeMB of 0 = unlimited.
    if (isOverFileSizeLimit(data.byteLength, this.config.maxFileSizeMB)) {
      const sizeMB = data.byteLength / 1024 / 1024;
      new Notice(
        `⚠️ File too large to sync: ${remotePath} (${sizeMB.toFixed(1)} MB > ${this.config.maxFileSizeMB} MB)`,
      );
      return 'skipped';
    }
    await client.uploadFile(remotePath, data, mtime, opts);
    return 'uploaded';
  }
}
