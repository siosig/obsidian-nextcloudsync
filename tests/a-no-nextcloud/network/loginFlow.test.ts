import { requestUrl } from 'obsidian';
import { LoginFlowV2 } from '../../../src/auth/LoginFlowV2';
import { LoginFlowError } from '../../../src/types';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

function res(status: number, json: unknown = {}) {
  return Promise.resolve({ status, text: '', json, arrayBuffer: new ArrayBuffer(0), headers: {} });
}

const noSleep = (): Promise<void> => Promise.resolve();
/** Resume signal that never fires — the desktop case, where the timer alone drives the loop. */
const noResume = () => () => undefined;

/**
 * A fake clock that advances by `stepMs` on every read, so a loop using `noSleep` still reaches the
 * wall-clock deadline in bounded time instead of spinning against the real `Date.now`.
 */
function fakeClock(stepMs: number) {
  let t = 0;
  return () => { const v = t; t += stepMs; return v; };
}

describe('LoginFlowV2', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  it('start() parses init response', async () => {
    mockRequestUrl.mockReturnValueOnce(res(200, {
      poll: { token: 'tok', endpoint: 'https://nc/login/v2/poll' },
      login: 'https://nc/login/flow',
    }));
    const init = await LoginFlowV2.start('https://nc');
    expect(init).toEqual({ pollToken: 'tok', pollEndpoint: 'https://nc/login/v2/poll', loginUrl: 'https://nc/login/flow' });
  });

  it('start() throws unsupported on 404', async () => {
    mockRequestUrl.mockReturnValueOnce(res(404));
    await expect(LoginFlowV2.start('https://nc')).rejects.toMatchObject({ reason: 'unsupported' } as Partial<LoginFlowError>);
  });

  it('pollOnce() returns pending on 404', async () => {
    mockRequestUrl.mockReturnValueOnce(res(404));
    const r = await LoginFlowV2.pollOnce({ pollToken: 't', pollEndpoint: 'e', loginUrl: 'l' });
    expect(r.status).toBe('pending');
  });

  it('pollOnce() returns success with credentials on 200', async () => {
    mockRequestUrl.mockReturnValueOnce(res(200, { server: 'https://nc', loginName: 'alice', appPassword: 'secret' }));
    const r = await LoginFlowV2.pollOnce({ pollToken: 't', pollEndpoint: 'e', loginUrl: 'l' });
    expect(r).toEqual({ status: 'success', server: 'https://nc', loginName: 'alice', appPassword: 'secret' });
  });

  it('poll() resolves success after a pending then success', async () => {
    mockRequestUrl
      .mockReturnValueOnce(res(404))
      .mockReturnValueOnce(res(200, { server: 'https://nc', loginName: 'bob', appPassword: 'pw' }));
    const r = await LoginFlowV2.poll({ pollToken: 't', pollEndpoint: 'e', loginUrl: 'l' }, noSleep, {
      now: fakeClock(1000), onResume: noResume,
    });
    expect(r.status).toBe('success');
  });

  it('poll() times out when never approved', async () => {
    mockRequestUrl.mockReturnValue(res(404));
    // 1-minute steps: the 20-minute budget is reached after a bounded number of iterations.
    const r = await LoginFlowV2.poll({ pollToken: 't', pollEndpoint: 'e', loginUrl: 'l' }, noSleep, {
      now: fakeClock(60_000), onResume: noResume,
    });
    expect(r.status).toBe('timeout');
  });

  // Issue #34: on mobile the webview's timers are suspended while the browser holds the foreground,
  // so the interval never fires and the loop parks on one await. Returning to the app must wake it.
  describe('[LF-1] polling survives a suspended timer and resumes when the app does', () => {
    it('polls again on resume even though the interval timer never fires', async () => {
      const neverSleep = (): Promise<void> => new Promise<void>(() => undefined); // suspended timer
      let resume: (() => void) | null = null;
      const onResume = (cb: () => void) => { resume = cb; return () => { resume = null; }; };

      mockRequestUrl
        .mockReturnValueOnce(res(404)) // first poll: not approved yet, then the browser takes over
        .mockReturnValueOnce(res(200, { server: 'https://nc', loginName: 'carol', appPassword: 'pw' }));

      const pending = LoginFlowV2.poll(
        { pollToken: 't', pollEndpoint: 'e', loginUrl: 'l' },
        neverSleep,
        { now: fakeClock(1000), onResume },
      );

      // Let the first poll settle, then simulate the user coming back from the browser.
      await Promise.resolve();
      await Promise.resolve();
      expect(resume).not.toBeNull();
      (resume as unknown as () => void)();

      await expect(pending).resolves.toEqual({
        status: 'success', server: 'https://nc', loginName: 'carol', appPassword: 'pw',
      });
      expect(mockRequestUrl).toHaveBeenCalledTimes(2);
    });

    it('unsubscribes from the resume signal once the flow finishes', async () => {
      const unsubscribe = jest.fn();
      mockRequestUrl.mockReturnValueOnce(res(200, { server: 'https://nc', loginName: 'd', appPassword: 'p' }));
      await LoginFlowV2.poll({ pollToken: 't', pollEndpoint: 'e', loginUrl: 'l' }, noSleep, {
        now: fakeClock(1000), onResume: () => unsubscribe,
      });
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('[LF-2] the deadline matches the server-side token lifetime (20 minutes)', () => {
      // Nextcloud's LoginFlowV2Mapper::lifetime is 1200 s; giving up earlier would strand a token
      // the server would still honour, which is what the old 90-iteration cap effectively did.
      expect(LoginFlowV2.POLL_DEADLINE_MS).toBe(20 * 60 * 1000);
    });
  });
});
