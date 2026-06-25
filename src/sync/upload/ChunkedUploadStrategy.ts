import { Notice } from 'obsidian';
import { NetworkError } from '../../types';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { IUploadStrategy, UploadConfig, UploadOutcome, UploadOptions } from './IUploadStrategy';
import { isOverFileSizeLimit } from '../../util/limits';

/** Size of a single chunk (bytes). A conservative 10MB to be mindful of memory. */
const CHUNK_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Strategy that chooses single upload / chunked upload / skip based on size and settings (for Nextcloud).
 *
 * - `> maxFileSizeMB`: skip (Notice warning)
 * - `> uploadChunkThresholdMB`: chunked upload (falls back to a single PUT on failure)
 * - below that: single PUT
 */
export class ChunkedUploadStrategy implements IUploadStrategy {
  constructor(private readonly config: UploadConfig) {}

  async upload(client: IWebDAVClient, remotePath: string, data: ArrayBuffer, mtime?: number, opts?: UploadOptions): Promise<UploadOutcome> {
    const sizeMB = data.byteLength / 1024 / 1024;

    // maxFileSizeMB of 0 means "unlimited".
    if (isOverFileSizeLimit(data.byteLength, this.config.maxFileSizeMB)) {
      new Notice(
        `⚠️ File too large to sync: ${remotePath} (${sizeMB.toFixed(1)} MB > ${this.config.maxFileSizeMB} MB)`,
      );
      return 'skipped';
    }

    if (sizeMB > this.config.uploadChunkThresholdMB) {
      try {
        await client.uploadChunked(remotePath, data, CHUNK_SIZE_BYTES);
        return 'uploaded';
      } catch (err) {
        // If chunked upload fails, fall back to a single PUT (FR-013).
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
