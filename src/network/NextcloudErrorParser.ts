import { Notice } from 'obsidian';

const EXCEPTION_MESSAGES: Record<string, string> = {
  'OC\\ServiceUnavailableException': '🔧 Nextcloud is in maintenance mode. Sync paused.',
  'Sabre\\DAV\\Exception\\InsufficientStorage': '💾 Nextcloud storage quota exceeded. Upload stopped.',
  'Sabre\\DAV\\Exception\\Locked': '🔒 File is locked by another client. Will retry.',
};

/** Parse Nextcloud/SabreDAV XML error body and show an appropriate Notice. */
export function parseAndNotifyNextcloudError(xmlBody: string, path = ''): void {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlBody, 'text/xml');
    const exceptionEl = doc.getElementsByTagName('s:exception')[0]
      ?? doc.getElementsByTagName('exception')[0];
    if (!exceptionEl) return;

    const exception = exceptionEl.textContent ?? '';
    const message = EXCEPTION_MESSAGES[exception];
    if (message) {
      new Notice(path ? `${message}\nFile: ${path}` : message, 8000);
    }
  } catch {
    // Not valid XML — ignore
  }
}
