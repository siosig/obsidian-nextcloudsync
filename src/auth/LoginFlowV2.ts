import { requestUrl } from 'obsidian';
import { LoginFlowInit, LoginFlowResult, LoginFlowError } from '../types';

/**
 * Nextcloud Login Flow v2 client.
 *
 * Official flow that issues an app password using browser approval alone.
 * 1. start(): POST /index.php/login/v2 → {@link LoginFlowInit}
 * 2. The user opens loginUrl in a browser and approves
 * 3. poll(): polls until approval completes and returns {@link LoginFlowResult}
 *
 * Everything goes through Obsidian's requestUrl (no fetch). No `any`; JSON is validated with type guards.
 */
export class LoginFlowV2 {
  /** Polling interval (milliseconds). */
  static readonly POLL_INTERVAL_MS = 2000;
  /** Maximum number of polls (about 3 minutes). */
  static readonly MAX_POLLS = 90;

  /**
   * Starts the Login Flow.
   * @param serverBaseUrl Server base URL without `/remote.php/...`
   * @returns Start info (browser URL and polling endpoint)
   * @throws {LoginFlowError} If the start POST fails
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
   * Checks for approval completion exactly once. Returns `pending` before approval, `success` once done.
   * @returns Polling result (discriminated union)
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
   * Polls until approval completes or the maximum number of polls is reached.
   * @param sleep Wait function injectable for testing (defaults to a setTimeout-based one)
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

  /** Validates the start response JSON with type guards and converts it to LoginFlowInit. */
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

  /** Validates the successful polling JSON with type guards. */
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
