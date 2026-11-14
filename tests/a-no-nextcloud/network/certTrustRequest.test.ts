import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { requestUrl } from '../support/obsidian';
import { LoginFlowV2 } from '../../../src/auth/LoginFlowV2';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { StandardWebDAVClient } from '../../../src/network/StandardWebDAVClient';
import {
  CERT_TRUST_FAQ_TITLE,
  CertTrustError,
  CertTrustPlatform,
  certTrustGuidance,
  failureText,
} from '../../../src/network/certTrust';
import { requestUrlWithGuidance, requestUrlWithTimeout } from '../../../src/network/requestWithTimeout';
import { DEFAULT_SETTINGS, DavSyncSettings, LoginFlowInit } from '../../../src/types';

// The request boundary of the untrusted-server-certificate guidance (docs/spec.md §11.3): every place that issues a
// request rejects with CertTrustError for a failure measured on a runtime, and passes every other outcome through unchanged.

const mockRequestUrl = requestUrl as unknown as jest.Mock;

const ANDROID_FULL =
  'Request Failed. SSLHandshakeException java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.';
const DESKTOP_TEXT = 'net::ERR_CERT_AUTHORITY_INVALID';

const PARAMS: RequestUrlParam = { url: 'https://h/x', method: 'PROPFIND' };

const settings: DavSyncSettings = {
  ...DEFAULT_SETTINGS,
  serverUrl: 'https://nc/remote.php/dav/files/alice/',
  username: 'alice',
  deviceId: 'device-abcd1234',
};

const response = (status: number): RequestUrlResponse => ({
  status,
  text: '',
  json: {},
  arrayBuffer: new ArrayBuffer(0),
  headers: {},
});

type Entry = (params: RequestUrlParam) => Promise<RequestUrlResponse>;

// The three entry points of the request boundary: no time limit, and the time-limited branch with a 30 s limit.
const GUIDANCE_ENTRY: [string, Entry] = ['requestUrlWithGuidance', (p) => requestUrlWithGuidance(p)];
const UNLIMITED_ENTRY: [string, Entry] = ['requestUrlWithTimeout(p, 0)', (p) => requestUrlWithTimeout(p, 0)];
const LIMITED_ENTRY: [string, Entry] = ['requestUrlWithTimeout(p, 30000)', (p) => requestUrlWithTimeout(p, 30000)];
const ENTRIES: Array<[string, Entry]> = [GUIDANCE_ENTRY, UNLIMITED_ENTRY, LIMITED_ENTRY];

interface Failure {
  name: string;
  // A fresh value per test, so each test can assert reference identity.
  make: () => unknown;
  platform: CertTrustPlatform;
}

const FAILURES: Failure[] = [
  { name: 'the Android text in an Error', make: () => new Error(ANDROID_FULL), platform: 'android' },
  { name: 'the desktop text in an Error', make: () => new Error(DESKTOP_TEXT), platform: 'desktop' },
  { name: 'the Android text as a string', make: () => ANDROID_FULL, platform: 'android' },
];

// The value a promise rejects with. Fails the test if the promise resolves instead.
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

function expectGuided(caught: unknown, failure: unknown, platform: CertTrustPlatform): void {
  expect(caught).toBeInstanceOf(CertTrustError);
  const err = caught as CertTrustError;
  expect(err.message.startsWith(failureText(failure))).toBe(true);
  expect(err.message).toContain(certTrustGuidance(platform));
  expect(err.platform).toBe(platform);
  expect(err.original).toBe(failure);
}

const DEFAULT_RESPONSE = (): Promise<RequestUrlResponse> => Promise.resolve(response(200));

beforeEach(() => {
  jest.useFakeTimers();
  mockRequestUrl.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
  mockRequestUrl.mockReset();
  // Back to the default implementation of support/obsidian.ts (a 200 response).
  mockRequestUrl.mockImplementation(DEFAULT_RESPONSE);
});

describe('[SPEC:CTE-3] an untrusted-issuer failure reaches the caller as CertTrustError', () => {
  describe('at the three entry points of the request boundary', () => {
    const rows = ENTRIES.flatMap(([entryName, entry]) =>
      FAILURES.map(({ name, make, platform }): [string, Entry, string, () => unknown, CertTrustPlatform] => [
        entryName,
        entry,
        name,
        make,
        platform,
      ]),
    );

    it.each(rows)('%s rejects with CertTrustError for %s', async (_entryName, entry, _failureName, make, platform) => {
      const failure = make();
      mockRequestUrl.mockRejectedValue(failure);

      const caught = await rejectionOf(entry(PARAMS));

      expectGuided(caught, failure, platform);
      expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });
  });

  describe('in the login flow', () => {
    const INIT: LoginFlowInit = {
      pollToken: 't',
      pollEndpoint: 'https://h/login/v2/poll',
      loginUrl: 'https://h/login/flow',
    };

    it.each<[string, () => Promise<unknown>]>([
      ["LoginFlowV2.start('https://h')", () => LoginFlowV2.start('https://h')],
      ['LoginFlowV2.pollOnce(init)', () => LoginFlowV2.pollOnce(INIT)],
    ])('%s rejects with CertTrustError and sends one request', async (_name, call) => {
      const failure = new Error(ANDROID_FULL);
      mockRequestUrl.mockRejectedValue(failure);

      const caught = await rejectionOf(call());

      expectGuided(caught, failure, 'android');
      expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });
  });

  // Same assembly as the NET-3 retry tests: the failure is retried like any other transient rejection (2 retries,
  // 1 s then 2 s), and the guidance is added once however many attempts ran.
  describe('through the read-only retry', () => {
    it('StandardWebDAVClient.statFile retries twice and then rejects with CertTrustError carrying the guidance once', async () => {
      mockRequestUrl.mockImplementation(() => Promise.reject(new Error(DESKTOP_TEXT)));

      const outcome = rejectionOf(new StandardWebDAVClient(settings, 'pw', 'Vault').statFile('Notes/a.md'));
      await jest.advanceTimersByTimeAsync(1000); // 1st backoff -> retry #1
      await jest.advanceTimersByTimeAsync(2000); // 2nd backoff -> retry #2
      const caught = await outcome;

      expect(mockRequestUrl).toHaveBeenCalledTimes(3); // initial + 2 retries
      expect(caught).toBeInstanceOf(CertTrustError);
      expect((caught as CertTrustError).message.split(CERT_TRUST_FAQ_TITLE).length).toBe(2);
    });

    it('NextcloudClient.statFile retries twice, logs one line per failed attempt, and rejects with CertTrustError carrying the guidance once', async () => {
      mockRequestUrl.mockImplementation(() => Promise.reject(new Error(DESKTOP_TEXT)));
      const lines: string[] = [];

      const client = new NextcloudClient(settings, 'pw', 'Vault', (msg) => {
        lines.push(msg);
      });
      const outcome = rejectionOf(client.statFile('Notes/a.md'));
      await jest.advanceTimersByTimeAsync(1000); // 1st backoff -> retry #1
      await jest.advanceTimersByTimeAsync(2000); // 2nd backoff -> retry #2
      const caught = await outcome;

      expect(mockRequestUrl).toHaveBeenCalledTimes(3); // initial + 2 retries
      expect(caught).toBeInstanceOf(CertTrustError);
      expect((caught as CertTrustError).message.split(CERT_TRUST_FAQ_TITLE).length).toBe(2);
      // withRetry asks its predicate (which logs) after every failed attempt, the last one included: 3 attempts, 3 lines.
      const retryLines = lines.filter((line) => line.startsWith('reqReadonly retry:'));
      expect(retryLines).toHaveLength(3);
      for (const line of retryLines) expect(line).toContain(DESKTOP_TEXT);
    });
  });

  describe('when the time limit expires first', () => {
    const expectTimeout = (caught: unknown): void => {
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(CertTrustError);
      const message = (caught as Error).message;
      expect(message.startsWith('Network request timed out after ')).toBe(true);
      expect(message).not.toContain(CERT_TRUST_FAQ_TITLE);
    };

    it('rejects with the timeout Error, not CertTrustError, when the request never settles', async () => {
      mockRequestUrl.mockReturnValue(new Promise<RequestUrlResponse>(() => undefined)); // a hung request

      const outcome = rejectionOf(requestUrlWithTimeout(PARAMS, 30000));
      await jest.advanceTimersByTimeAsync(30000);

      expectTimeout(await outcome);
    });

    it('keeps the timeout Error when the request rejects with an untrusted-issuer failure after the time limit', async () => {
      let rejectLate: (reason: unknown) => void = () => undefined;
      mockRequestUrl.mockReturnValue(
        new Promise<RequestUrlResponse>((_resolve, reject) => {
          rejectLate = reject;
        }),
      );

      const outcome = rejectionOf(requestUrlWithTimeout(PARAMS, 30000));
      await jest.advanceTimersByTimeAsync(30000);
      rejectLate(new Error(ANDROID_FULL)); // arrives after the timer already settled the promise
      await jest.advanceTimersByTimeAsync(0);

      expectTimeout(await outcome);
    });
  });
});

describe('[SPEC:CTE-4] every other outcome passes through unchanged', () => {
  it.each(ENTRIES)('%s rejects with the same Error object for a certificate failure that is not an untrusted issuer', async (_name, entry) => {
    const err = new Error('net::ERR_CERT_DATE_INVALID');
    mockRequestUrl.mockRejectedValue(err);

    await expect(entry(PARAMS)).rejects.toBe(err);
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  it.each([GUIDANCE_ENTRY, UNLIMITED_ENTRY])('%s rejects with the same string for a non-certificate failure', async (_name, entry) => {
    mockRequestUrl.mockRejectedValue('net::ERR_CONNECTION_REFUSED');

    await expect(entry(PARAMS)).rejects.toBe('net::ERR_CONNECTION_REFUSED');
  });

  it('requestUrlWithTimeout(p, 30000) rejects with an Error of the same text for a non-certificate string failure (as before)', async () => {
    mockRequestUrl.mockRejectedValue('net::ERR_CONNECTION_REFUSED');

    const caught = await rejectionOf(requestUrlWithTimeout(PARAMS, 30000));

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(CertTrustError);
    expect((caught as Error).message).toBe('net::ERR_CONNECTION_REFUSED');
  });

  it.each(ENTRIES)('%s resolves with the same response object for an HTTP 404 under throw: false', async (_name, entry) => {
    const notFound = response(404);
    const params: RequestUrlParam = { url: 'https://h/x', method: 'GET', throw: false };
    mockRequestUrl.mockResolvedValue(notFound);

    await expect(entry(params)).resolves.toBe(notFound);
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    expect(mockRequestUrl).toHaveBeenCalledWith(params);
  });
});
