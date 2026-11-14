// docs/spec.md §11.3: the guidance travels inside the request failure's `message`, so every sync surface
// (notice, log, session result) shows it unchanged. These surfaces are unmodified code, fed a guided failure.
import { Notice } from '../support/obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { DEFAULT_SETTINGS } from '../../../src/types';
import type { SyncSessionSummary } from '../../../src/types';
import { CERT_TRUST_FAQ_TITLE, withCertTrustGuidance } from '../../../src/network/certTrust';

const ANDROID_FAILURE =
  'Request Failed. SSLHandshakeException java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.';

type SurfaceEngine = {
  syncManual(o?: { manual?: boolean }): Promise<void>;
  getStatusReport(): { summary: SyncSessionSummary | null };
};

describe('[SPEC:CTE-5] SyncEngine — an untrusted-certificate failure reaches every sync surface with its guidance', () => {
  // Same assembly as the CONC-1 suite: createClient rejects, so ensureClient fails inside runSyncSession.
  function makeFailingEngine(failure: unknown) {
    const logs: string[] = [];
    const createClient = jest.fn(async () => { throw withCertTrustGuidance(failure); });
    const opts = {
      app: {},
      settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false },
      localAdapter: {},
      stateDB: {
        setLastSyncTime: jest.fn(),
        save: jest.fn(async () => undefined),
        countConflicted: jest.fn(() => 0),
        getSyncToken: jest.fn(() => null),
        getAllFiles: jest.fn(() => []),
      },
      statusBar: { setStatus: jest.fn(), setSyncComplete: jest.fn() },
      webdavFactory: { createClient },
      logger: { log: jest.fn(async (m: string) => { logs.push(m); }) },
      pluginDir: '', configDir: '.obsidian',
    };
    const engine = new SyncEngine(opts as never) as unknown as SurfaceEngine;
    return { engine, createClient, logs };
  }

  beforeEach(() => {
    Notice.instances.length = 0;
  });

  it.each([
    ['desktop (net::ERR_CERT_AUTHORITY_INVALID)', new Error('net::ERR_CERT_AUTHORITY_INVALID')],
    ['Android (full SSLHandshakeException text)', ANDROID_FAILURE],
  ])('shows the same guided message in the notice, the log and the session result: %s', async (_label, failure) => {
    // testEnvironment is 'node'; isBlockedByWifiOnly reads navigator.connection. syncOnWifiOnly=false
    // short-circuits, but guard the global so older runtimes without a `navigator` don't ReferenceError.
    (globalThis as { navigator?: unknown }).navigator ??= {};
    const err = withCertTrustGuidance(failure) as Error;
    expect(err.message).toContain(CERT_TRUST_FAQ_TITLE); // the failure fed to the surfaces really carries the guidance
    const { engine, createClient, logs } = makeFailingEngine(failure);

    await expect(engine.syncManual({ manual: true })).resolves.toBeUndefined();

    // Notice.
    const notices = Notice.instances;
    expect(notices[notices.length - 1].message).toBe(`❌ Sync failed: ${err.message}`);

    // Log: the session-level failure line.
    expect(logs).toContain(`sync: FAILED — ${err.message}`);

    // Session result: the error detail carries the same message, and the journal logs it per error.
    const { summary } = engine.getStatusReport();
    expect(summary).not.toBeNull();
    const errors = (summary as SyncSessionSummary).errors;
    expect(errors.some((e) => e.message === err.message)).toBe(true);
    expect(logs.some((l) => l.startsWith('sync: error ') && l.includes(err.message))).toBe(true);

    // The guided failure must not strand the running guard: the next sync runs again instead of balking.
    expect(createClient).toHaveBeenCalledTimes(1);
    await expect(engine.syncManual({ manual: true })).resolves.toBeUndefined();
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(logs.filter((l) => l === 'sync: skipped — already running')).toHaveLength(0);
  });
});
