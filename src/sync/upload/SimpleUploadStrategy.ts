import { IWebDAVClient } from '../../network/IWebDAVClient';
import { IUploadStrategy, UploadOutcome } from './IUploadStrategy';

/** Strategy that always sends via a single PUT (standard WebDAV / default fallback). */
export class SimpleUploadStrategy implements IUploadStrategy {
  async upload(client: IWebDAVClient, remotePath: string, data: ArrayBuffer): Promise<UploadOutcome> {
    await client.uploadFile(remotePath, data);
    return 'uploaded';
  }
}
