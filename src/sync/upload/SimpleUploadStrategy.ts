import { IWebDAVClient } from '../../network/IWebDAVClient';
import { IUploadStrategy, UploadConfig, UploadOutcome, UploadOptions } from './IUploadStrategy';
import { isOverFileSizeLimit } from '../../util/limits';

export class SimpleUploadStrategy implements IUploadStrategy {
  constructor(private readonly config: UploadConfig) {}

  async upload(client: IWebDAVClient, remotePath: string, data: ArrayBuffer, mtime?: number, opts?: UploadOptions): Promise<UploadOutcome> {
    // Skipping large files guards mobile memory (OOM). maxFileSizeMB of 0 = unlimited.
    if (isOverFileSizeLimit(data.byteLength, this.config.maxFileSizeMB())) return 'skipped';
    await client.uploadFile(remotePath, data, mtime, opts);
    return 'uploaded';
  }
}
