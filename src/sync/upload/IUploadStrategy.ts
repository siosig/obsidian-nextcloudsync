import { IWebDAVClient } from '../../network/IWebDAVClient';

/** アップロードの結果。スキップ（上限超過）か送信完了かを表す。 */
export type UploadOutcome = 'uploaded' | 'skipped';

/**
 * アップロード戦略（DIP）。サイズ・Capability に応じて単一送信／チャンク送信／スキップを切り替える。
 */
export interface IUploadStrategy {
  /**
   * ファイルをアップロードする。
   * @returns 上限超過でスキップした場合 'skipped'、送信した場合 'uploaded'
   */
  upload(client: IWebDAVClient, remotePath: string, data: ArrayBuffer): Promise<UploadOutcome>;
}
