// Isolate the wrapper from Obsidian: provide a controllable requestUrl mock for this file only.
jest.mock('obsidian', () => ({ requestUrl: jest.fn() }));

import { requestUrl } from 'obsidian';
import { requestUrlWithTimeout } from '../../../src/network/requestWithTimeout';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

describe('[SPEC:NET-1] requestUrlWithTimeout — bounds a hanging WebDAV request', () => {
  afterEach(() => { jest.clearAllMocks(); });

  it('resolves with the response when the request completes before the timeout', async () => {
    mockRequestUrl.mockResolvedValue({ status: 200, text: 'ok' });
    await expect(requestUrlWithTimeout({ url: 'https://h/x' } as never, 30_000))
      .resolves.toMatchObject({ status: 200 });
  });

  it('rejects with a timeout error when the request never settles', async () => {
    mockRequestUrl.mockReturnValue(new Promise(() => { /* never resolves — a hung request */ }));
    await expect(requestUrlWithTimeout({ url: 'https://h/x', method: 'PROPFIND' } as never, 20))
      .rejects.toThrow(/timed out/);
  });

  it('propagates the underlying error when the request rejects before the timeout', async () => {
    mockRequestUrl.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(requestUrlWithTimeout({ url: 'https://h/x' } as never, 30_000))
      .rejects.toThrow('ECONNREFUSED');
  });

  it('does not arm a timeout when timeoutMs <= 0 (unbounded escape hatch)', async () => {
    // With no timeout the wrapper returns the underlying requestUrl promise directly, so even a slow
    // resolve is honored and no timer can reject it.
    mockRequestUrl.mockResolvedValue({ status: 207 });
    await expect(requestUrlWithTimeout({ url: 'https://h/x' } as never, 0)).resolves.toMatchObject({ status: 207 });
    mockRequestUrl.mockResolvedValue({ status: 207 });
    await expect(requestUrlWithTimeout({ url: 'https://h/x' } as never, -1)).resolves.toMatchObject({ status: 207 });
  });
});
