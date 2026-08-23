// Server-side approval of a Nextcloud Login Flow v2 request, so the b-3 sign-in scenario does not
// need a human tapping "Grant access" in a browser.
//
// The endpoint contract below was read off the server's own controller
// (refs/nextcloud-server .../ClientFlowLoginV2Controller.php), not guessed:
//
//   GET  /index.php/login/v2/flow/{token}   landing; stores the login token in the session
//   GET  /index.php/login/v2/flow           auth picker; mints a stateToken into the session and
//                                           embeds it in the page's initial state
//   POST /index.php/login/v2/apptoken       PublicPage; approves with {stateToken, user, password}
//
// The important subtlety: `apptoken` calls getToken($password) and requires the password to be an
// EXISTING app password, not the account's login password. So we mint one first via OCS.
//
// All three requests share one session, which we carry by hand — Node's fetch has no cookie jar.

export interface LoginFlowApprovalTarget {
  /** Server base URL, no /index.php and no trailing slash. */
  baseUrl: string;
  user: string;
  /** The account's login password (used only to mint an app password over OCS). */
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

/** Mints a fresh app password over OCS. Required because `apptoken` rejects login passwords. */
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

/**
 * Pulls the CSRF request token out of the page.
 *
 * `apptoken` is a PublicPage but still goes through the CSRF middleware, which answers 412
 * "CSRF check failed" without this. A browser sends it automatically from the page's
 * `data-requesttoken`; a bare fetch has to read it off the HTML and pass it as a header.
 */
function extractRequestToken(html: string): string {
  const m = html.match(/data-requesttoken="([^"]+)"/);
  if (!m) throw new Error('could not find data-requesttoken on the auth picker page');
  return m[1];
}

/** Pulls the stateToken out of the auth-picker page's embedded initial state. */
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

/**
 * Approves a pending Login Flow v2 request, exactly as a human would by granting access in a browser.
 * After this resolves, the client's poll endpoint returns the credentials.
 *
 * @param loginUrl the `login` URL handed back by the flow's start call
 */
export async function approveLoginFlow(
  target: LoginFlowApprovalTarget,
  loginUrl: string,
): Promise<void> {
  const jar = new CookieJar();
  const appPassword = await createAppPassword(target);

  // 1. Landing: binds the login token to THIS session and redirects to the auth picker.
  //
  // Redirects must be followed by hand. Node's fetch follows them but has no cookie jar, so the
  // session cookie the landing response sets is dropped and the picker arrives unauthenticated —
  // the server then reports "Login token not set in session" as a 403, which reads like a
  // permissions problem rather than a lost cookie.
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

  // 2. If we did not land on the picker, fetch it explicitly — with the session cookie this time.
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

  // 3. Approve.
  //
  // Nextcloud's SameSite cookie middleware answers 412 to any POST that arrives without its
  // `nc_sameSiteCookie*` markers — a browser gets them automatically, a bare fetch does not. The
  // symptom is a bare "HTTP 412" that looks like a precondition on the flow itself.
  //
  // The names carry a `__Host-` prefix whenever the session cookie is secure and scoped to `/`
  // (Request::getProtectedCookieName), which is exactly our case over HTTPS. Both spellings are sent
  // so the approval also works against a plain-HTTP instance.
  for (const name of ['nc_sameSiteCookielax', 'nc_sameSiteCookiestrict']) {
    jar.set(name, 'true');
    jar.set(`__Host-${name}`, 'true');
  }
  // A 2xx/3xx here means the flow is done and the client's next poll will succeed.
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

/** Strips `/remote.php/...` off a DAV URL to get the server base the login flow needs. */
export function serverBaseFromDavUrl(davUrl: string): string {
  return davUrl.replace(/\/remote\.php.*$/, '').replace(/\/$/, '');
}
