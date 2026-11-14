// [SPEC:CTE-5] docs/spec.md §11.3: an untrusted-server-certificate failure of the login flow keeps its original
// text and gains the guidance, and the toast and the log line carry the same text.
import type { App } from 'obsidian';
import { Notice, requestUrl } from '../support/obsidian';
import { NextcloudSyncSettingTab } from '../../../src/settings/SettingTab';
import { DEFAULT_SETTINGS } from '../../../src/types';
import { certTrustGuidance } from '../../../src/network/certTrust';
import type { CertTrustPlatform } from '../../../src/network/certTrust';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

const NOTICE_PREFIX = '❌ Login failed: ';
const LOG_PREFIX = 'login: ERROR — ';

function setup() {
  const logs: string[] = [];
  const plugin = {
    settings: { ...DEFAULT_SETTINGS, serverUrl: 'https://h/remote.php/dav/files/u/' },
    saveSettings: jest.fn(async () => {}),
    logger: { log: jest.fn(async (m: string) => { logs.push(m); }) },
  };
  const tab = new NextcloudSyncSettingTab({} as App, plugin as never);
  return { tab, logs };
}

describe('[SPEC:CTE-5] login flow failure caused by an untrusted server certificate', () => {
  beforeEach(() => {
    Notice.instances = [];
    mockRequestUrl.mockReset();
  });

  it.each<{ runtime: string; failureText: string; platform: CertTrustPlatform }>([
    {
      runtime: 'Android',
      failureText: 'Request Failed. SSLHandshakeException java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.',
      platform: 'android',
    },
    {
      runtime: 'desktop',
      failureText: 'net::ERR_CERT_AUTHORITY_INVALID',
      platform: 'desktop',
    },
  ])('$runtime: the toast and the log carry the original text followed by the guidance', async ({ failureText, platform }) => {
    mockRequestUrl.mockRejectedValueOnce(new Error(failureText));
    const { tab, logs } = setup();

    await tab.startLoginFlow();

    // The failure reached the login flow's error handler: one request was made and a failure toast was shown.
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    const notice = Notice.instances[Notice.instances.length - 1];
    expect(notice).toBeDefined();
    expect(notice.message.startsWith(NOTICE_PREFIX)).toBe(true);

    // m: the message the login flow shows. It starts with the original text and contains the guidance.
    const m = notice.message.slice(NOTICE_PREFIX.length);
    expect(m.startsWith(failureText)).toBe(true);
    expect(m).toContain(certTrustGuidance(platform));

    // The log line carries exactly the same message as the toast.
    expect(logs).toContain(`${LOG_PREFIX}${m}`);
  });
});
