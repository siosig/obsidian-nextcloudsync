import {
  DIR_BREAKER_REPORT_FILENAME,
  FILE_BREAKER_REPORT_FILENAME,
  formatDirBreakerReportNote,
  formatFileBreakerReportNote,
} from '../../../src/ui/breakerReport';

describe('[SPEC:MDV-7] breaker report note formatting (feature 056)', () => {
  test('formatDirBreakerReportNote lists every path in both categories with counts, no truncation', () => {
    const deleteRemote = Array.from({ length: 15 }, (_, i) => `remote-only/d${i}`);
    const trashLocal = Array.from({ length: 12 }, (_, i) => `local-only/d${i}`);
    const note = formatDirBreakerReportNote({ deleteRemote, trashLocal });

    expect(note).toContain('# Nextcloud Sync — directory mass-delete breaker report');
    expect(note).toContain(`(${deleteRemote.length})`);
    expect(note).toContain(`(${trashLocal.length})`);
    for (const p of [...deleteRemote, ...trashLocal]) {
      expect(note).toContain(`- ${p}`);
    }
    // No "…and N more" truncation anywhere — the whole point is full review.
    expect(note).not.toMatch(/…and \d+ more/);
  });

  test('formatDirBreakerReportNote renders "(none)" placeholders for an empty category', () => {
    const note = formatDirBreakerReportNote({ deleteRemote: [], trashLocal: ['x'] });
    expect(note).toContain('(0)');
    expect(note).toContain('*(none)*');
    expect(note).toContain('- x');
  });

  test('formatFileBreakerReportNote lists every path with a count, no truncation', () => {
    const all = Array.from({ length: 23 }, (_, i) => `note${i}.md`);
    const note = formatFileBreakerReportNote(all);
    expect(note).toContain('# Nextcloud Sync — file mass-delete breaker report');
    expect(note).toContain(`(${all.length})`);
    for (const p of all) {
      expect(note).toContain(`- ${p}`);
    }
    expect(note).not.toMatch(/…and \d+ more/);
  });

  test('formatFileBreakerReportNote renders "(none)" placeholder for an empty list', () => {
    const note = formatFileBreakerReportNote([]);
    expect(note).toContain('(0)');
    expect(note).toContain('*(none)*');
  });

  test('fixed report filenames are distinct and vault-root markdown files', () => {
    expect(DIR_BREAKER_REPORT_FILENAME).toBe('nextcloud-sync-dir-breaker-report.md');
    expect(FILE_BREAKER_REPORT_FILENAME).toBe('nextcloud-sync-file-breaker-report.md');
    expect(DIR_BREAKER_REPORT_FILENAME).not.toBe(FILE_BREAKER_REPORT_FILENAME);
  });
});
