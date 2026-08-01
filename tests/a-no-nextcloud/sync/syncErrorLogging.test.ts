import { SyncEngine } from '../../../src/sync/SyncEngine';
import { NetworkError, SyncErrorDetail, SyncSessionSummary } from '../../../src/types';

/**
 * [SPEC:URE-5] feature 065 (GitHub issue #25).
 *
 * The reporter's debug log ended at `sync: done ... err=162` and named none of the 162 failing
 * paths, so the one artefact they could hand over located nothing — the investigation stalled on
 * missing diagnostics rather than on the bug itself. The per-file failures were already being
 * collected for the status dialog; they just never reached the log.
 *
 * These tests drive the real `logSessionErrors` (the method `sync()`'s finally block calls) against
 * a recording logger.
 */

const err = (path: string, message: string): SyncErrorDetail => ({ path, message });

function makeSummary(errors: SyncErrorDetail[]): SyncSessionSummary {
  return {
    startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0,
    deletedCount: 0, mergedCount: 0, conflictedCount: 0,
    errorCount: errors.length, retriedFiles: [], errors,
  };
}

type Privates = { logSessionErrors: (s: SyncSessionSummary) => void };

function buildEngine(logger?: { log: jest.Mock }) {
  const opts = {
    app: {}, settings: {}, localAdapter: {}, stateDB: {},
    statusBar: {}, webdavFactory: {}, pluginDir: '', configDir: '.obsidian',
    logger,
  };
  return new SyncEngine(opts as never) as unknown as Privates;
}

describe('[SPEC:URE-5] SyncEngine.logSessionErrors — every failure reaches the debug log', () => {
  it('writes one line per failed file, naming the path', () => {
    const logger = { log: jest.fn() };
    buildEngine(logger).logSessionErrors(makeSummary([
      err('Directory Name/FileName.md', 'HTTP 404 (GET)'),
      err('This Is A Note.md', 'HTTP 404 (PUT)'),
    ]));

    const lines: string[] = logger.log.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Directory Name/FileName.md');
    expect(lines[0]).toContain('HTTP 404 (GET)');
    expect(lines[1]).toContain('This Is A Note.md');
    expect(lines[1]).toContain('HTTP 404 (PUT)');
  });

  // The reporter's real run produced 162 failures. A capped list would read as "these were all of
  // them" and send the next investigation down the same dead end, so the count must be exact.
  it('is uncapped — 162 failures produce 162 lines, each individually identifiable', () => {
    const logger = { log: jest.fn() };
    const errors = Array.from({ length: 162 }, (_, i) => err(`Folder ${i}/note ${i}.md`, 'HTTP 404 (PROPFIND)'));
    buildEngine(logger).logSessionErrors(makeSummary(errors));

    const lines: string[] = logger.log.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(162);
    expect(new Set(lines).size).toBe(162);
    expect(lines[161]).toContain('Folder 161/note 161.md');
  });

  it('emits nothing when the session had no failures', () => {
    const logger = { log: jest.fn() };
    buildEngine(logger).logSessionErrors(makeSummary([]));
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('does not throw when logging is disabled (no logger wired)', () => {
    expect(() => buildEngine(undefined).logSessionErrors(makeSummary([err('a.md', 'HTTP 500 (PUT)')])))
      .not.toThrow();
  });

  // Users paste this log into public issues, so a server response body — which can echo request
  // headers, including Authorization — must never ride along. NetworkError already keeps the body
  // off `message`; this asserts the log inherits that property end to end.
  it('carries no credentials: the response body never reaches the log line', () => {
    const logger = { log: jest.fn() };
    const netErr = new NetworkError(401, 'denied for Basic YWxpY2U6c3VwZXJzZWNyZXQ=', 'PROPFIND');
    buildEngine(logger).logSessionErrors(makeSummary([err('secret note.md', netErr.message)]));

    const line = String(logger.log.mock.calls[0][0]);
    expect(line).toContain('HTTP 401 (PROPFIND)');
    expect(line).not.toContain('YWxpY2U');
    expect(line).not.toContain('supersecret');
  });
});
