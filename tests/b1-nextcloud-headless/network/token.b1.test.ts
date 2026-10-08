// Layer A — sync-token / incremental sync (TK-1..2). SKIPPED on this server: it returns 415 (Sabre ReportNotSupported)
// for the sync-collection REPORT used by getChanges/getSyncToken, so the engine degrades to full-scan and incremental
// REPORT (TK-1) and 410 token expiry (TK-2) cannot be exercised.
import { describeLive } from '../support/env';

describeLive('Layer A — sync-token (TK)', () => {
  it.skip('TK-1 incremental REPORT returns modified/deleted/newToken (server: REPORT 415)', () => undefined);
  it.skip('TK-2 expired token (410) → SyncTokenExpiredError (n/a: REPORT unsupported)', () => undefined);
});
