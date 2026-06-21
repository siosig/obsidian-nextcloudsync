// Layer A — sync-token / incremental sync (TK-1..2) per report/mock_test.md §3.I.
//
// SKIPPED on this server: it returns HTTP 415 (Sabre ReportNotSupported,
// "The {DAV:}sync-collection REPORT is not supported on this url") for the
// sync-collection REPORT used by getChanges/getSyncToken. The engine therefore
// degrades to full-scan, so incremental REPORT (TK-1) and 410 token expiry
// (TK-2) cannot be exercised here. Verified via Nextcloud app logs (2026-06-21).
import { describeLive } from '../support/env';

describeLive('Layer A — sync-token (TK)', () => {
  it.skip('TK-1 incremental REPORT returns modified/deleted/newToken (server: REPORT 415)', () => undefined);
  it.skip('TK-2 expired token (410) → SyncTokenExpiredError (n/a: REPORT unsupported)', () => undefined);
});
