import { requestUrl } from 'obsidian';
import { LoginFlowInit, LoginFlowResult, LoginFlowError } from '../types';

/**
 * Nextcloud Login Flow v2 クライアント。
 *
 * ブラウザ承認のみでアプリパスワードを発行する公式フロー。
 * 1. start(): POST /index.php/login/v2 → {@link LoginFlowInit}
 * 2. ユーザーが loginUrl をブラウザで開いて承認
 * 3. poll(): 承認完了までポーリングし {@link LoginFlowResult} を返す
 *
 * すべて Obsidian の requestUrl 経由（fetch 不使用）。`any` 不使用・型ガードで JSON を検証する。
 */
export class LoginFlowV2 {
  /** ポーリング間隔（ミリ秒）。 */
  static readonly POLL_INTERVAL_MS = 2000;
  /** 最大ポーリング回数（約3分）。 */
  static readonly MAX_POLLS = 90;

  /**
   * Login Flow を開始する。
   * @param serverBaseUrl `/remote.php/...` を含まないサーバーのベース URL
   * @returns 開始情報（ブラウザ URL とポーリング先）
   * @throws {LoginFlowError} 開始 POST が失敗した場合
   */
  static async start(serverBaseUrl: string): Promise<LoginFlowInit> {
    const base = serverBaseUrl.replace(/\/$/, '');
    const res = await requestUrl({
      url: `${base}/index.php/login/v2`,
      method: 'POST',
      headers: { 'User-Agent': 'Obsidian Nextcloud Sync' },
      throw: false,
    });
    if (res.status === 404 || res.status === 405) {
      throw new LoginFlowError('unsupported');
    }
    if (res.status < 200 || res.status >= 300) {
      throw new LoginFlowError(`HTTP ${res.status}`);
    }
    const init = this.parseInit(res.json);
    if (!init) throw new LoginFlowError('invalid start response');
    return init;
  }

  /**
   * 承認完了を一度だけ確認する。承認前は `pending`、完了で `success`。
   * @returns ポーリング結果（判別付きユニオン）
   */
  static async pollOnce(init: LoginFlowInit): Promise<LoginFlowResult> {
    const res = await requestUrl({
      url: init.pollEndpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(init.pollToken)}`,
      throw: false,
    });
    if (res.status === 404) return { status: 'pending' };
    if (res.status < 200 || res.status >= 300) return { status: 'pending' };
    const ok = this.parseSuccess(res.json);
    if (!ok) return { status: 'pending' };
    return { status: 'success', ...ok };
  }

  /**
   * 承認完了まで、または最大回数までポーリングする。
   * @param sleep テスト用に待機関数を注入可能（既定は setTimeout ベース）
   */
  static async poll(
    init: LoginFlowInit,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => window.setTimeout(r, ms)),
  ): Promise<LoginFlowResult> {
    for (let i = 0; i < this.MAX_POLLS; i++) {
      const result = await this.pollOnce(init);
      if (result.status === 'success') return result;
      await sleep(this.POLL_INTERVAL_MS);
    }
    return { status: 'timeout' };
  }

  /** 開始レスポンス JSON を型ガードで検証して LoginFlowInit に変換する。 */
  private static parseInit(json: unknown): LoginFlowInit | null {
    if (typeof json !== 'object' || json === null) return null;
    const obj = json as Record<string, unknown>;
    const login = obj.login;
    const poll = obj.poll;
    if (typeof login !== 'string') return null;
    if (typeof poll !== 'object' || poll === null) return null;
    const pollObj = poll as Record<string, unknown>;
    const token = pollObj.token;
    const endpoint = pollObj.endpoint;
    if (typeof token !== 'string' || typeof endpoint !== 'string') return null;
    return { pollToken: token, pollEndpoint: endpoint, loginUrl: login };
  }

  /** ポーリング成功 JSON を型ガードで検証する。 */
  private static parseSuccess(
    json: unknown,
  ): { server: string; loginName: string; appPassword: string } | null {
    if (typeof json !== 'object' || json === null) return null;
    const obj = json as Record<string, unknown>;
    const server = obj.server;
    const loginName = obj.loginName;
    const appPassword = obj.appPassword;
    if (typeof server !== 'string' || typeof loginName !== 'string' || typeof appPassword !== 'string') {
      return null;
    }
    return { server, loginName, appPassword };
  }
}
