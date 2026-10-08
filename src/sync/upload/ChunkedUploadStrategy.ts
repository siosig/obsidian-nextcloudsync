import { Notice } from 'obsidian';
import { NetworkError } from '../../types';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { IUploadStrategy, UploadConfig, UploadOutcome, UploadOptions } from './IUploadStrategy';
import { isOverFileSizeLimit } from '../../util/limits';

// 10MB per chunk keeps memory use modest.
const CHUNK_SIZE_BYTES = 10 * 1024 * 1024;

// Above maxFileSizeMB: skip with a Notice. Above uploadChunkThresholdMB: chunked, falling back to a single PUT on failure.
export class ChunkedUploadStrategy implements IUploadStrategy {
  constructor(private readonly config: UploadConfig) {}

  async upload(client: IWebDAVClient, remotePath: string, data: ArrayBuffer, mtime?: number, opts?: UploadOptions): Promise<UploadOutcome> {
    const sizeMB = data.byteLength / 1024 / 1024;

    // maxFileSizeMB of 0 means unlimited.
    if (isOverFileSizeLimit(data.byteLength, this.config.maxFileSizeMB)) {
      new Notice(
        `⚠️ File too large to sync: ${remotePath} (${sizeMB.toFixed(1)} MB > ${this.config.maxFileSizeMB} MB)`,
      );
      return 'skipped';
    }

    if (sizeMB > this.config.uploadChunkThresholdMB) {
      try {
        await client.uploadChunked(remotePath, data, CHUNK_SIZE_BYTES, opts);
        return 'uploaded';
      } catch (err) {
        // A failed chunked upload falls back to a single PUT.
        console.warn(`[ChunkedUploadStrategy] chunked upload failed, falling back to PUT: ${remotePath}`, err);
        if (err instanceof NetworkError) {
          await client.uploadFile(remotePath, data, mtime, opts);
          return 'uploaded';
        }
        throw err;
      }
    }

    await client.uploadFile(remotePath, data, mtime, opts);
    return 'uploaded';
  }
}
