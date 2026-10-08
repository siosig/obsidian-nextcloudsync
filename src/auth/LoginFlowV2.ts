import { requestUrl } from 'obsidian';
import { LoginFlowInit, LoginFlowResult, LoginFlowError } from '../types';
import { onAppResume } from '../util/appResume';

// Nextcloud Login Flow v2: start() POSTs /index.php/login/v2, the user approves in a browser, poll() collects the app password.
// All requests go through Obsidian's requestUrl (no fetch).

// Default app-resume signal (issue #34): mobile suspends the webview's timers while the browser holds the foreground,
// so the poll loop needs a second way to be woken.
const defaultOnResume = onAppResume;

export interface PollDeps {
  now?: () => number;
  onResume?: (cb: () => void) => () => void;
}

export class LoginFlowV2 {
  static readonly POLL_INTERVAL_MS = 2000;
  // Wall-clock budget for the whole flow, matched to Nextcloud's token lifetime (LoginFlowV2Mapper::lifetime = 1200s)
  // so the client never stops earlier than the server honours the token.
  static readonly POLL_DEADLINE_MS = 20 * 60 * 1000;

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

  // Waits between polls on whichever comes first: the interval timer or the app returning to the foreground. The timer alone
  // broke Android sign-in (issue #34): the suspended webview never fires setTimeout, so the ready app password was never collected.
  static async poll(
    init: LoginFlowInit,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => window.setTimeout(r, ms)),
    deps: PollDeps = {},
  ): Promise<LoginFlowResult> {
    const now = deps.now ?? (() => Date.now());
    const onResume = deps.onResume ?? defaultOnResume;
    const deadline = now() + this.POLL_DEADLINE_MS;

    let wake: (() => void) | null = null;
    const unsubscribe = onResume(() => wake?.());
    try {
      while (now() < deadline) {
        const result = await this.pollOnce(init);
        if (result.status === 'success') return result;
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            wake = null;
            resolve();
          };
          wake = finish;
          // The timer may never fire (suspended webview); `finish` is idempotent, so whichever of the
          // two arrives first wins and the loser is a no-op when it eventually runs.
          void sleep(this.POLL_INTERVAL_MS).then(finish);
        });
      }
      return { status: 'timeout' };
    } finally {
      unsubscribe();
    }
  }

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
