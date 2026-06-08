import { IWebDAVClient } from '../../network/IWebDAVClient';

/** Result of an upload: either skipped (over the size limit) or sent. */
export type UploadOutcome = 'uploaded' | 'skipped';

/**
 * Upload strategy (DIP). Switches between single PUT / chunked upload / skip
 * depending on file size and server capabilities.
 */
export interface IUploadStrategy {
  /**
   * Upload a file.
   * @returns 'skipped' when skipped due to the size limit, 'uploaded' when sent.
   */
  upload(client: IWebDAVClient, remotePath: string, data: ArrayBuffer, mtime?: number): Promise<UploadOutcome>;
}
