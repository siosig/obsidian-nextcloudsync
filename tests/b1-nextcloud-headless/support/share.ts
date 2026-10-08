// Share helper for the two-account tests (LK-4 / SL-1): the admin shares a file with a second user via the OCS
// Files Sharing API so that user's client can contend with the admin's server-side lock.
import { LiveEnv } from './env';
import { authHeaderOf } from './clientFactory';

// Shares read/write (permissions=31); throws unless the OCS status code is 200.
export async function shareWithUser(env: LiveEnv, ownerPath: string, shareWith: string): Promise<void> {
  const url = `${new URL(env.serverUrl).origin}/ocs/v2.php/apps/files_sharing/api/v1/shares`;
  const body = new URLSearchParams({
    path: `/${ownerPath}`,
    shareType: '0',
    shareWith,
    permissions: '31',
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'OCS-APIRequest': 'true',
      Authorization: authHeaderOf(env),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const text = await res.text();
  let statuscode: unknown;
  try {
    statuscode = (JSON.parse(text) as { ocs?: { meta?: { statuscode?: unknown } } }).ocs?.meta?.statuscode;
  } catch {
    // Non-JSON body: fall through to the error below with the HTTP status and body excerpt.
  }
  if (statuscode !== 200) {
    throw new Error(
      `shareWithUser failed: HTTP ${res.status}, ocs statuscode ${String(statuscode)}: ${text.slice(0, 300)}`,
    );
  }
}
