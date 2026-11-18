// docs/spec.md §15.2: every sync reads the app password before connecting, even with a cached client.
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { DEFAULT_SETTINGS } from '../../../src/types';
import type { SyncSessionSummary } from '../../../src/types';

type PasswordEngine = {
  syncManual(o?: { manual?: boolean }): Promise<void>;
  getStatusReport(): { summary: SyncSessionSummary | null };
};

// What createClient resolves with. Typed so that a test can hand its own connection to mockImplementationOnce.
type Connection = { client: object; features: object };

// The private members the replacement-connection tests reach through a cast (ensureClient is not part of the public API).
type EngineInternals = { ensureClient(): Promise<unknown>; client: unknown };

const PASSWORD_ERROR = 'App password not found in credentials';

// Every method rejects: a stub client is never expected to serve a request. Only 'then' (so that awaiting it works) and
// LABEL are answered. A stub client must never reach a jest matcher: pretty-format probes unknown properties such as
// hasAttribute() and would call into the stub, whose unhandled rejection kills the jest worker. Tests compare clients
// through idOf() instead.
const LABEL = Symbol('label');
const stubClient = (label: string): object => new Proxy({}, {
  get: (_t, prop) => (prop === 'then' ? undefined : prop === LABEL ? label : async () => { throw new Error('stub client'); }),
});
const idOf = (client: unknown): string | null => (client === null ? null : String((client as Record<symbol, unknown>)[LABEL]));

describe('SyncEngine — the app password is read for every sync', () => {
  // Same assembly as certTrustSurfaces.test.ts, but createClient succeeds. Everything after the connection runs
  // against a client whose every method rejects: that failure is expected and never asserted on. Only the number of
  // createClient calls, the last onFeatures argument and the password errors in the session summary decide.
  let pw: string | null;
  // When set, the reader throws it, standing in for a secret storage that fails outright.
  let readerError: Error | null;

  // onConnect runs inside createClient, before the connection is returned: it stands in for a secret that changes
  // while the connection is being made. It receives the zero-based index of the createClient call.
  function makeEngine(features: object[], onConnect?: (index: number) => void) {
    let connections = 0;
    const createClient = jest.fn(async (): Promise<Connection> => {
      const index = connections;
      const own = features[Math.min(index, features.length - 1)];
      onConnect?.(index);
      connections++;
      return { client: stubClient(`connection ${index}`), features: { isNextcloud: true, hasFilesLocking: false, ...own } };
    });
    const onFeatures = jest.fn();
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
        // Called right after the connection (invalidateRootEtagOnScopeChange).
        getSyncScopeFingerprint: jest.fn(() => null),
        setSyncScopeFingerprint: jest.fn(),
        setRemoteRootEtag: jest.fn(),
      },
      statusBar: { setStatus: jest.fn(), setSyncComplete: jest.fn() },
      webdavFactory: { createClient },
      readAppPassword: () => { if (readerError) throw readerError; return pw; },
      onFeatures,
      logger: { log: jest.fn(async () => undefined) },
      pluginDir: '', configDir: '.obsidian',
    };
    // Cast: SyncEngineOptions is the contract under test, and this assembly deliberately supplies only what a sync reads.
    const engine = new SyncEngine(opts as never) as unknown as PasswordEngine;
    const pwErrors = () =>
      (engine.getStatusReport().summary?.errors ?? []).filter((e) => e.message === PASSWORD_ERROR).length;
    const lastFeatures = () => {
      const calls = onFeatures.mock.calls;
      return calls[calls.length - 1]?.[0] as { hasFilesLocking: boolean } | undefined;
    };
    const internals = engine as unknown as EngineInternals;
    // The client the i-th createClient call returned (zero-based).
    const clientOf = async (i: number): Promise<unknown> => ((await createClient.mock.results[i].value) as Connection).client;
    return { engine, createClient, pwErrors, lastFeatures, internals, clientOf };
  }

  beforeEach(() => {
    pw = null;
    readerError = null;
    // testEnvironment is 'node'; isBlockedByWifiOnly reads navigator.connection. syncOnWifiOnly=false
    // short-circuits, but guard the global so older runtimes without a `navigator` don't ReferenceError.
    (globalThis as { navigator?: unknown }).navigator ??= {};
  });

  it.each([null, ''])('[SPEC:APW-3] a %p secret fails the next sync before connecting, even with a cached client', async (cleared) => {
    const { engine, createClient, pwErrors } = makeEngine([{}]);

    pw = 'pw';
    await engine.syncManual({ manual: true });
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(pwErrors()).toBe(0);

    pw = cleared;
    await engine.syncManual({ manual: true });
    expect(pwErrors()).toBe(1);
    expect(createClient).toHaveBeenCalledTimes(1);

    // Back to the value the connection was made with: the cached connection is reused.
    pw = 'pw';
    await engine.syncManual({ manual: true });
    expect(pwErrors()).toBe(0);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('[SPEC:APW-5] a password different from the one the connection was made with rebuilds the connection', async () => {
    const { engine, createClient, pwErrors, lastFeatures } = makeEngine([{ hasFilesLocking: false }, { hasFilesLocking: true }]);

    pw = 'wrong';
    await engine.syncManual({ manual: true });
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(lastFeatures()?.hasFilesLocking).toBe(false);

    // Features detected under the wrong password are dropped with the connection.
    pw = 'right';
    await engine.syncManual({ manual: true });
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(lastFeatures()?.hasFilesLocking).toBe(true);

    await engine.syncManual({ manual: true });
    expect(createClient).toHaveBeenCalledTimes(2);

    // A cleared secret fails the sync without touching the connection made with 'right'.
    pw = null;
    await engine.syncManual({ manual: true });
    expect(pwErrors()).toBe(1);
    expect(createClient).toHaveBeenCalledTimes(2);

    pw = 'right';
    await engine.syncManual({ manual: true });
    expect(pwErrors()).toBe(0);
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it('[SPEC:APW-2] an engine that never connected connects on the first sync after the password is set', async () => {
    const { engine, createClient, pwErrors } = makeEngine([{}]);

    // No password yet (pw is null): the sync fails before any connection is made.
    await engine.syncManual({ manual: true });
    expect(pwErrors()).toBe(1);
    expect(createClient).toHaveBeenCalledTimes(0);

    // The password is set afterwards: the same engine connects on its next sync.
    pw = 'first';
    await engine.syncManual({ manual: true });
    expect(pwErrors()).toBe(0);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('[SPEC:APW-3] a reader that throws fails the sync with that error and the next sync recovers', async () => {
    const { engine, createClient, pwErrors } = makeEngine([{}]);
    const messages = () => (engine.getStatusReport().summary?.errors ?? []).map((e) => e.message);

    pw = 'pw';
    await engine.syncManual({ manual: true });
    expect(createClient).toHaveBeenCalledTimes(1);

    // The reader's own error reaches the session summary; the sync never proceeds past the connection step.
    readerError = new Error('secret storage unavailable');
    await engine.syncManual({ manual: true });
    expect(messages()).toContain('secret storage unavailable');
    expect(pwErrors()).toBe(0);
    expect(messages()).not.toContain('stub client');
    expect(createClient).toHaveBeenCalledTimes(1);

    // The reader works again with the value the connection was made with: the cached connection is reused.
    readerError = null;
    pw = 'pw';
    await engine.syncManual({ manual: true });
    expect(messages()).not.toContain('secret storage unavailable');
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('[SPEC:APW-5] a password that changes while connecting rebuilds the connection on the next sync', async () => {
    // The secret becomes 'right' while the first connection is being made with the 'wrong' value it read.
    const { engine, createClient, lastFeatures } = makeEngine(
      [{ hasFilesLocking: false }, { hasFilesLocking: true }],
      (index) => { if (index === 0) pw = 'right'; },
    );

    pw = 'wrong';
    await engine.syncManual({ manual: true });
    // The createClient count right after this sync is not asserted: a later ensureClient call inside the sync may
    // already have rebuilt the connection. The expectations below hold either way.

    await engine.syncManual({ manual: true });
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(lastFeatures()?.hasFilesLocking).toBe(true);

    // The connection made with 'right' is reused.
    await engine.syncManual({ manual: true });
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it('[SPEC:APW-5] keeps the previous connection while the replacement is being made', async () => {
    const { engine, createClient, internals, clientOf } = makeEngine([{}]);

    pw = 'a';
    await engine.syncManual({ manual: true });
    expect(createClient).toHaveBeenCalledTimes(1);
    const first = await clientOf(0);
    expect(idOf(internals.client)).toBe(idOf(first));

    // A different password starts a replacement connection that stays pending.
    pw = 'b';
    let release!: (v: Connection) => void;
    createClient.mockImplementationOnce(() => new Promise<Connection>((r) => { release = r; }));
    const rebuilding = internals.ensureClient();
    expect(createClient).toHaveBeenCalledTimes(2);
    // A concurrent caller (listVersions and the like) must still find the previous connection.
    expect(idOf(internals.client)).toBe(idOf(first));

    const second: Connection = { client: stubClient('replacement'), features: { isNextcloud: true, hasFilesLocking: false } };
    release(second);
    await rebuilding;
    expect(idOf(internals.client)).toBe('replacement');
  });

  it('[SPEC:APW-5] keeps the previous connection when the replacement fails, and rebuilds on the next call', async () => {
    const { engine, createClient, internals, clientOf } = makeEngine([{}]);

    pw = 'a';
    await engine.syncManual({ manual: true });
    const first = await clientOf(0);

    pw = 'b';
    createClient.mockImplementationOnce(() => Promise.reject(new Error('replacement failed')));
    await expect(internals.ensureClient()).rejects.toThrow('replacement failed');
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(idOf(internals.client)).toBe(idOf(first));

    // Nothing was recorded for 'b': the next call retries the replacement and succeeds.
    await internals.ensureClient();
    expect(createClient).toHaveBeenCalledTimes(3);
    expect(idOf(internals.client)).toBe(idOf(await clientOf(2)));
  });
});
