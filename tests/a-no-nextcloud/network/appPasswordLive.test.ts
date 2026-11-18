// docs/spec.md §15.2: the app password is resolved when it is used, so a changed secret applies from the next request.
//
// The clients and the factory take a reader function instead of a string and call it for every Authorization header, so
// rewriting the stored secret or selecting another one applies from the next request without rebuilding anything. A reader
// that yields nothing (null or '') fails closed with CredentialsNotFoundError before any request is sent.
import type { App } from 'obsidian';
import { requestUrl } from 'obsidian';
import { WebDAVFactory } from '../../../src/network/WebDAVFactory';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { StandardWebDAVClient } from '../../../src/network/StandardWebDAVClient';
import { loadAppPassword } from '../../../src/settings/SettingTab';
import { AppPasswordReader, CredentialsNotFoundError, DEFAULT_SETTINGS, DavSyncSettings } from '../../../src/types';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

const MULTISTATUS = '<d:multistatus xmlns:d="DAV:"></d:multistatus>';
const DEFAULT_SECRET_ID = 'obsidian-nextcloudsync-password';

let secrets: Map<string, string>;
let settings: DavSyncSettings;
let app: App;
let connectSpy: jest.SpyInstance | undefined;

function res(status: number, body: Partial<{ text: string; json: unknown }> = {}) {
  return Promise.resolve({
    status,
    text: body.text ?? '',
    json: body.json ?? {},
    arrayBuffer: new ArrayBuffer(0),
    headers: {},
  });
}

const NEXTCLOUD_STATUS = { installed: true, maintenance: false, version: '34.0.1.1', versionstring: '34.0.1', productname: 'Nextcloud' };
const OCS_CAPABILITIES = { ocs: { data: { version: { string: '34.0.1' }, capabilities: {} } } };

// Route probe responses by URL so a case reads as "what the server answers", not "what the Nth call returns".
function serveProbes(opts: {
  status?: () => Promise<unknown>;
  capabilities?: () => Promise<unknown>;
  dav?: () => ReturnType<typeof res>;
}): void {
  mockRequestUrl.mockImplementation((p: { url: string }) => {
    if (p.url.includes('status.php')) return (opts.status ?? (() => res(404)))();
    if (p.url.includes('ocs/v1.php')) return (opts.capabilities ?? (() => res(404)))();
    return (opts.dav ?? (() => res(207, { text: MULTISTATUS })))();
  });
}

// A healthy Nextcloud (both probes answer) keeps the Nextcloud client. The DAV answer is a 200 so downloadFile succeeds.
const NEXTCLOUD_ANSWERS = {
  status: () => res(200, { json: NEXTCLOUD_STATUS }),
  capabilities: () => res(200, { json: OCS_CAPABILITIES }),
  dav: () => res(200),
};
// A plain WebDAV server: both probes 404, so the factory falls to the standard client. A 200 is accepted by its connect().
const STANDARD_ANSWERS = { dav: () => res(200) };

const basic = (user: string, pw: string) => 'Basic ' + Buffer.from(`${user}:${pw}`, 'utf8').toString('base64');

// Every Authorization header the mocked transport has received since the last mockClear().
function authHeaders(): string[] {
  return mockRequestUrl.mock.calls
    .map((c: [{ headers?: Record<string, string> }]) => c[0].headers?.Authorization)
    .filter((h: string | undefined): h is string => h !== undefined);
}

// The distinct headers, so one assertion states both "at least one request carried a header" and "all of them were this one".
const distinctAuthHeaders = (): string[] => [...new Set(authHeaders())];

type Change = 'rewrite' | 'reselect';

// A reader plus the one mutation that changes what it returns from 'old' to 'new':
//  - rewrite: the same secret ID gets a new value (a plain variable stands in for the stored value);
//  - reselect: another secret ID is chosen, read the way main.ts reads it (loadAppPassword over the live settings).
function readerFor(change: Change): { reader: AppPasswordReader; mutate: () => void } {
  if (change === 'rewrite') {
    let pw: string | null = 'old';
    return { reader: () => pw, mutate: () => { pw = 'new'; } };
  }
  secrets.set('id-a', 'old');
  secrets.set('id-b', 'new');
  settings.passwordSecretId = 'id-a';
  return {
    reader: () => loadAppPassword(app, settings.passwordSecretId),
    mutate: () => { settings.passwordSecretId = 'id-b'; },
  };
}

beforeEach(() => {
  mockRequestUrl.mockReset();
  secrets = new Map();
  settings = { ...DEFAULT_SETTINGS, serverUrl: 'https://cloud.example.com/remote.php/dav/files/alice/', username: 'alice' };
  app = {
    vault: { getName: () => 'Vault' },
    secretStorage: { getSecret: (id: string) => secrets.get(id) ?? null },
    loadLocalStorage: () => null,
  } as never;
});

afterEach(() => {
  connectSpy?.mockRestore();
  connectSpy = undefined;
});

const CLIENTS = [
  ['nextcloud', NEXTCLOUD_ANSWERS, NextcloudClient],
  ['standard', STANDARD_ANSWERS, StandardWebDAVClient],
] as const;

describe('[SPEC:APW-1] a changed app password applies from the next request', () => {
  describe.each(CLIENTS)('%s client', (_name, answers, ClientClass) => {
    describe.each<Change>(['rewrite', 'reselect'])('%s', (change) => {
      it.each(['before connect', 'after connect'] as const)('changed %s: every request carries the new password', async (when) => {
        serveProbes(answers);
        const { reader, mutate } = readerFor(change);
        const factory = new WebDAVFactory(app, settings, reader);

        if (when === 'before connect') {
          mutate();
          const { client } = await factory.createClient();

          expect(client).toBeInstanceOf(ClientClass);
          expect(distinctAuthHeaders()).toEqual([basic('alice', 'new')]);
          return;
        }

        const { client } = await factory.createClient();
        expect(client).toBeInstanceOf(ClientClass);
        // The connection was made under the old password: the change below is what the next request must pick up.
        expect(distinctAuthHeaders()).toEqual([basic('alice', 'old')]);

        mockRequestUrl.mockClear();
        mutate();
        await client.downloadFile('a.md').catch(() => undefined);

        expect(distinctAuthHeaders()).toEqual([basic('alice', 'new')]);
      });
    });
  });
});

describe('[SPEC:APW-3] a password that cannot be resolved fails closed before any request', () => {
  it.each([null, ''])('createClient rejects without a request when the reader returns %p', async (value) => {
    serveProbes(NEXTCLOUD_ANSWERS);

    await expect(new WebDAVFactory(app, settings, () => value).createClient()).rejects.toBeInstanceOf(CredentialsNotFoundError);

    expect(mockRequestUrl).toHaveBeenCalledTimes(0);
  });

  describe.each(CLIENTS)('%s client after connect', (_name, answers) => {
    it.each([null, ''])('a request rejects without reaching the transport when the reader starts returning %p', async (value) => {
      serveProbes(answers);
      let pw: string | null = 'old';
      const { client } = await new WebDAVFactory(app, settings, () => pw).createClient();
      mockRequestUrl.mockClear();
      pw = value;

      await expect(client.downloadFile('a.md')).rejects.toBeInstanceOf(CredentialsNotFoundError);

      expect(mockRequestUrl).toHaveBeenCalledTimes(0);
    });

    it('selecting a secret ID that holds no value rejects without reaching the transport', async () => {
      serveProbes(answers);
      secrets.set('id-a', 'old');
      settings.passwordSecretId = 'id-a';
      const { client } = await new WebDAVFactory(app, settings, () => loadAppPassword(app, settings.passwordSecretId)).createClient();
      mockRequestUrl.mockClear();
      settings.passwordSecretId = 'missing';

      await expect(client.downloadFile('a.md')).rejects.toBeInstanceOf(CredentialsNotFoundError);

      expect(mockRequestUrl).toHaveBeenCalledTimes(0);
    });
  });

  describe('clearing the selection falls back to the default secret ID', () => {
    const readLive: AppPasswordReader = () => loadAppPassword(app, settings.passwordSecretId);

    it('uses the value stored under the default ID', async () => {
      serveProbes(NEXTCLOUD_ANSWERS);
      secrets.set(DEFAULT_SECRET_ID, 'default-pw');
      settings.passwordSecretId = '';

      const { client } = await new WebDAVFactory(app, settings, readLive).createClient();

      expect(client).toBeInstanceOf(NextcloudClient);
      expect(distinctAuthHeaders()).toEqual([basic('alice', 'default-pw')]);
    });

    it('rejects without a request when the default ID holds no value', async () => {
      serveProbes(NEXTCLOUD_ANSWERS);
      settings.passwordSecretId = '';

      await expect(new WebDAVFactory(app, settings, readLive).createClient()).rejects.toBeInstanceOf(CredentialsNotFoundError);

      expect(mockRequestUrl).toHaveBeenCalledTimes(0);
    });
  });

  it('a password that vanishes during connect is not read as "not Nextcloud": no retry with the standard client', async () => {
    serveProbes(NEXTCLOUD_ANSWERS);
    connectSpy = jest.spyOn(StandardWebDAVClient.prototype, 'connect');
    let reads = 0;
    // The factory's own check sees 'old'; the capabilities probe inside NextcloudClient.connect then sees nothing.
    const reader: AppPasswordReader = () => (reads++ === 0 ? 'old' : null);

    await expect(new WebDAVFactory(app, settings, reader).createClient()).rejects.toBeInstanceOf(CredentialsNotFoundError);

    expect(connectSpy).toHaveBeenCalledTimes(0);
  });

  // A reader that throws (for example a secret store that is unavailable) is not caught anywhere: the sync fails with
  // that very error, and a stale value is never used to authenticate.
  it('createClient rejects with the reader\'s own error and sends no request', async () => {
    serveProbes(NEXTCLOUD_ANSWERS);
    const boom = new Error('secret storage unavailable');
    const reader: AppPasswordReader = () => { throw boom; };

    await expect(new WebDAVFactory(app, settings, reader).createClient()).rejects.toBe(boom);

    expect(mockRequestUrl).toHaveBeenCalledTimes(0);
  });

  describe.each(CLIENTS)('%s client after connect, reader throws', (_name, answers) => {
    it('a request rejects with the reader\'s own error after connect, without reaching the transport', async () => {
      serveProbes(answers);
      const boom = new Error('secret storage unavailable');
      let broken = false;
      const reader: AppPasswordReader = () => {
        if (broken) throw boom;
        return 'old';
      };
      const { client } = await new WebDAVFactory(app, settings, reader).createClient();
      mockRequestUrl.mockClear();
      broken = true;

      await expect(client.downloadFile('a.md')).rejects.toBe(boom);

      expect(mockRequestUrl).toHaveBeenCalledTimes(0);

      // The failure is not sticky: once the reader works again, the next request on the same client authenticates.
      broken = false;
      await client.downloadFile('a.md');

      expect(distinctAuthHeaders()).toEqual([basic('alice', 'old')]);
    });
  });
});

describe('[SPEC:APW-2] a password set after start-up is used without a restart', () => {
  type Late = { reader: AppPasswordReader; store: () => void };

  // Each case builds a reader that yields nothing yet, plus the one step that stores the password afterwards.
  const CASES: Array<[string, () => Late]> = [
    [
      'a variable assigned after the factory is created',
      () => {
        let pw: string | null = null;
        return { reader: () => pw, store: () => { pw = 'first'; } };
      },
    ],
    [
      'loadAppPassword over a secret stored after the factory is created',
      () => {
        settings.passwordSecretId = 'id-a';
        return {
          reader: () => loadAppPassword(app, settings.passwordSecretId),
          store: () => { secrets.set(settings.passwordSecretId, 'first'); },
        };
      },
    ],
  ];

  it.each(CASES)('%s: createClient succeeds and every request carries the stored password', async (_name, build) => {
    serveProbes(NEXTCLOUD_ANSWERS);
    const { reader, store } = build();
    const factory = new WebDAVFactory(app, settings, reader);

    store();
    await expect(factory.createClient()).resolves.toBeDefined();

    expect(distinctAuthHeaders()).toEqual([basic('alice', 'first')]);
  });
});
