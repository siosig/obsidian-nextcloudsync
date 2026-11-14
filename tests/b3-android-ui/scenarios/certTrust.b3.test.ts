// [SPEC:CTE-8] Platform contract (docs/spec.md §11.3): the failure text of the real Android Obsidian `requestUrl` for an
// untrusted server certificate is what the classifier assumes. Only a real device reproduces it: the Java TLS wording
// reaches the plugin through Capacitor's native HTTP path, which a, b-1 and b-2 never take. `untrusted.test` is signed by a
// throwaway CA that is in no trust store, `expired.test` by the run's CA with a date in the past, `wrongname.test` serves
// the `nc.test` certificate under another name. The plugin's own code is not involved: the text is taken from the
// runtime and classified here.
import { browser, expect } from '@wdio/globals';
import { classifyCertTrustFailure } from '../../../src/network/certTrust';
import { requireAndroidEnv, requireEnvOrSkip } from '../support/env';

requireAndroidEnv();

// Runs inside Obsidian: the failure text of one request, or ok=true when the request succeeded.
async function probe(url: string): Promise<{ ok: boolean; text: string }> {
  return (await browser.executeObsidian(
    async ({ obsidian }, target: string) => {
      try {
        await obsidian.requestUrl({ url: target, throw: false });
        return { ok: true, text: '' };
      } catch (e) {
        return { ok: false, text: e instanceof Error ? e.message : String(e) };
      }
    },
    url,
  )) as { ok: boolean; text: string };
}

describe('[SPEC:CTE-8] b-3 — Android failure texts for untrusted, expired and misnamed server certificates', function () {
  before(async function () {
    requireEnvOrSkip(this);
  });

  it('[SPEC:CTE-8] an untrusted issuer is classified as android', async function () {
    const url = 'https://untrusted.test/';
    const r = await probe(url);
    expect({ url, ok: r.ok, platform: classifyCertTrustFailure(r.text), text: r.text }).toEqual({
      url,
      ok: false,
      platform: 'android',
      text: r.text,
    });
  });

  it('[SPEC:CTE-8] an expired certificate gets no guidance', async function () {
    const url = 'https://expired.test/';
    const r = await probe(url);
    expect({ url, ok: r.ok, platform: classifyCertTrustFailure(r.text), text: r.text }).toEqual({
      url,
      ok: false,
      platform: null,
      text: r.text,
    });
  });

  it('[SPEC:CTE-8] a certificate for another name gets no guidance', async function () {
    const url = 'https://wrongname.test/';
    const r = await probe(url);
    expect({ url, ok: r.ok, platform: classifyCertTrustFailure(r.text), text: r.text }).toEqual({
      url,
      ok: false,
      platform: null,
      text: r.text,
    });
  });
});
