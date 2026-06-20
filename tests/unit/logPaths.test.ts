import { joinLogPath, syncLogPath, debugLogPath } from '../../src/util/logPaths';

describe('logPaths — log files use the .txt extension', () => {
  // The logs are plain text (not Markdown); a .md extension makes editors
  // render them as Markdown and garble the output. They must be .txt.
  it('sync-log path ends with .txt', () => {
    expect(syncLogPath('_logs', 'desktop-abc')).toBe('_logs/nextcloud-sync_sync_desktop-abc.txt');
  });

  it('debug-log path ends with .txt', () => {
    expect(debugLogPath('_logs', 'desktop-abc')).toBe('_logs/nextcloud-sync_debug_desktop-abc.txt');
  });

  it('blank logsFolder puts the file at the vault root', () => {
    expect(syncLogPath('', 'ios')).toBe('nextcloud-sync_sync_ios.txt');
    expect(debugLogPath('', 'ios')).toBe('nextcloud-sync_debug_ios.txt');
  });

  it('joinLogPath strips trailing slashes', () => {
    expect(joinLogPath('_logs/', 'x.txt')).toBe('_logs/x.txt');
  });
});
