// Server-side approval of a Nextcloud Login Flow v2 request, so the b-3 sign-in scenario needs no human tapping "Grant access".
// Endpoints (from Nextcloud's ClientFlowLoginV2Controller):
//   GET  /index.php/login/v2/flow/{token}   landing; stores the login token in the session
//   GET  /index.php/login/v2/flow           auth picker; mints a stateToken and embeds it in the page's initial state
//   POST /index.php/login/v2/apptoken       approves with {stateToken, user, password}
// `apptoken` requires an existing app password, not the login password, so one is minted first via OCS.
// All three requests share one session, carried by hand because Node's fetch has no cookie jar.

export interface LoginFlowApprovalTarget {
  // Server base URL, no /index.php and no trailing slash.
  baseUrl: string;
  user: string;
  // The account's login password (used only to mint an app password over OCS).
  password: string;
}

class CookieJar {
  private readonly jar = new Map<string, string>();

  absorb(res: Response): void {
    // getSetCookie() is the only way to see multiple Set-Cookie headers; older runtimes fold them.
    const raw = typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie() as string[]
      : [res.headers.get('set-cookie')].filter((v): v is string => !!v);
    for (const line of raw) {
      const pair = line.split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  set(name: string, value: string): void {
    this.jar.set(name, value);
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

// Required because `apptoken` rejects login passwords.
export async function createAppPassword(target: LoginFlowApprovalTarget): Promise<string> {
  const res = await fetch(`${target.baseUrl}/ocs/v2.php/core/getapppassword?format=json`, {
    headers: {
      Authorization: basic(target.user, target.password),
      'OCS-APIRequest': 'true',
    },
  });
  if (!res.ok) throw new Error(`getapppassword failed: HTTP ${res.status}`);
  const json = (await res.json()) as { ocs?: { data?: { apppassword?: string } } };
  const pw = json.ocs?.data?.apppassword;
  if (!pw) throw new Error('getapppassword returned no apppassword');
  return pw;
}

// `apptoken` goes through the CSRF middleware, which answers 412 without this header; a browser sends it from
// the page's `data-requesttoken`, a bare fetch must read it off the HTML.
function extractRequestToken(html: string): string {
  const m = html.match(/data-requesttoken="([^"]+)"/);
  if (!m) throw new Error('could not find data-requesttoken on the auth picker page');
  return m[1];
}

function extractStateToken(html: string): string {
  // The page embeds base64-encoded JSON in an input named for the initial-state key.
  const encoded = html.match(/id="initial-state-core-loginFlowAuth"\s+value="([^"]+)"/);
  if (encoded) {
    try {
      const json = JSON.parse(Buffer.from(encoded[1], 'base64').toString('utf-8')) as { stateToken?: string };
      if (json.stateToken) return json.stateToken;
    } catch {
      // fall through to the direct scan below
    }
  }
  // Fallback: the token is a 64-char alphanumeric string; match it wherever it appears.
  const direct = html.match(/"stateToken"\s*:\s*"([A-Za-z0-9]{64})"/);
  if (direct) return direct[1];
  throw new Error('could not find stateToken on the auth picker page');
}

// After this resolves, the client's poll endpoint returns the credentials.
export async function approveLoginFlow(
  target: LoginFlowApprovalTarget,
  loginUrl: string,
): Promise<void> {
  const jar = new CookieJar();
  const appPassword = await createAppPassword(target);

  // Landing binds the login token to THIS session. Redirects must be followed by hand: without a cookie jar the
  // session cookie is dropped and the server answers a misleading 403 "Login token not set in session".
  let html = '';
  let url = loginUrl;
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(url, { redirect: 'manual', headers: { Cookie: jar.header() } });
    jar.absorb(res);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`login flow redirect without Location (HTTP ${res.status})`);
      url = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`login flow landing failed: HTTP ${res.status} at ${url}`);
    html = await res.text();
    break;
  }

  // If we did not land on the picker, fetch it explicitly with the session cookie.
  if (!/initial-state-core-loginFlowAuth|stateToken/.test(html)) {
    const picker = await fetch(`${target.baseUrl}/index.php/login/v2/flow`, {
      redirect: 'manual',
      headers: { Cookie: jar.header() },
    });
    jar.absorb(picker);
    if (!picker.ok) throw new Error(`auth picker failed: HTTP ${picker.status}`);
    html = await picker.text();
  }
  const stateToken = extractStateToken(html);
  const requestToken = extractRequestToken(html);

  // Nextcloud's SameSite cookie middleware answers 412 to a POST without its `nc_sameSiteCookie*` markers, which a
  // browser sends automatically. Names get a `__Host-` prefix over HTTPS (Request::getProtectedCookieName); send both
  // spellings so plain-HTTP instances work too.
  for (const name of ['nc_sameSiteCookielax', 'nc_sameSiteCookiestrict']) {
    jar.set(name, 'true');
    jar.set(`__Host-${name}`, 'true');
  }
  const body = new URLSearchParams({ stateToken, user: target.user, password: appPassword });
  const grant = await fetch(`${target.baseUrl}/index.php/login/v2/apptoken`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: jar.header(),
      'Content-Type': 'application/x-www-form-urlencoded',
      requesttoken: requestToken,
    },
    body,
  });
  if (grant.status >= 400) {
    const detail = (await grant.text()).slice(0, 200);
    throw new Error(`login flow approval rejected: HTTP ${grant.status} — ${detail}`);
  }
}

export function serverBaseFromDavUrl(davUrl: string): string {
  return davUrl.replace(/\/remote\.php.*$/, '').replace(/\/$/, '');
}
