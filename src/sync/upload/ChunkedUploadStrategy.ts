import { Notice } from 'obsidian';
import { DavSyncSettings, NetworkError } from '../../types';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { IUploadStrategy, UploadOutcome } from './IUploadStrategy';

/** 1チャンクのサイズ（バイト）。メモリ配慮で控えめな 10MB。 */
const CHUNK_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * サイズと設定に応じて単一送信／チャンク送信／スキップを選ぶ戦略（Nextcloud 用）。
 *
 * - `> maxFileSizeMB`: スキップ（Notice 警告）
 * - `> uploadChunkThresholdMB`: チャンク送信（失敗時は単一 PUT にフォールバック）
 * - それ以下: 単一 PUT
 */
export class ChunkedUploadStrategy implements IUploadStrategy {
  constructor(private readonly settings: DavSyncSettings) {}

  async upload(client: IWebDAVClient, remotePath: string, data: ArrayBuffer): Promise<UploadOutcome> {
    const sizeMB = data.byteLength / 1024 / 1024;

    if (sizeMB > this.settings.maxFileSizeMB) {
      new Notice(
        `⚠️ File too large to sync: ${remotePath} (${sizeMB.toFixed(1)} MB > ${this.settings.maxFileSizeMB} MB)`,
      );
      return 'skipped';
    }

    if (sizeMB > this.settings.uploadChunkThresholdMB) {
      try {
        await client.uploadChunked(remotePath, data, CHUNK_SIZE_BYTES);
        return 'uploaded';
      } catch (err) {
        // チャンク送信に失敗したら単一 PUT にフォールバックする（FR-013）。
        console.warn(`[ChunkedUploadStrategy] chunked upload failed, falling back to PUT: ${remotePath}`, err);
        if (err instanceof NetworkError) {
          await client.uploadFile(remotePath, data);
          return 'uploaded';
        }
        throw err;
      }
    }

    await client.uploadFile(remotePath, data);
    return 'uploaded';
  }
}
