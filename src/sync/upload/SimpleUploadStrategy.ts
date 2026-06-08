import { IWebDAVClient } from '../../network/IWebDAVClient';
import { IUploadStrategy, UploadOutcome } from './IUploadStrategy';

/** 常に単一 PUT で送信する戦略（標準 WebDAV・既定フォールバック）。 */
export class SimpleUploadStrategy implements IUploadStrategy {
  async upload(client: IWebDAVClient, remotePath: string, data: ArrayBuffer): Promise<UploadOutcome> {
    await client.uploadFile(remotePath, data);
    return 'uploaded';
  }
}
