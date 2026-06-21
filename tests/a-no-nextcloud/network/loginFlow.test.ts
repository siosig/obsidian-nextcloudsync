import { requestUrl } from 'obsidian';
import { LoginFlowV2 } from '../../../src/auth/LoginFlowV2';
import { LoginFlowError } from '../../../src/types';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

function res(status: number, json: unknown = {}) {
  return Promise.resolve({ status, text: '', json, arrayBuffer: new ArrayBuffer(0), headers: {} });
}

const noSleep = (): Promise<void> => Promise.resolve();

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
    const r = await LoginFlowV2.poll({ pollToken: 't', pollEndpoint: 'e', loginUrl: 'l' }, noSleep);
    expect(r.status).toBe('success');
  });

  it('poll() times out when never approved', async () => {
    mockRequestUrl.mockReturnValue(res(404));
    const r = await LoginFlowV2.poll({ pollToken: 't', pollEndpoint: 'e', loginUrl: 'l' }, noSleep);
    expect(r.status).toBe('timeout');
  });
});
