// Shared fixtures and small builders for the E2E suite. No secrets here.
import { sha256 } from '../../../src/util/hash';

/** Encode a UTF-8 string to an ArrayBuffer. */
export function textBuf(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

/** Decode an ArrayBuffer as UTF-8. */
export function decodeBuf(ab: ArrayBuffer): string {
  return new TextDecoder('utf-8').decode(ab);
}

/** Deterministic buffer of `n` bytes (byte i = i % 251), for size/chunk tests. */
export function bytesBuf(n: number): ArrayBuffer {
  const arr = new Uint8Array(n);
  for (let i = 0; i < n; i++) arr[i] = i % 251;
  return arr.buffer;
}

/** Compare two ArrayBuffers for byte equality. */
export function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const ua = new Uint8Array(a);
  const ub = new Uint8Array(b);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

/** SHA-256 hex of a buffer (re-exported from the plugin's own hash util). */
export async function sha256Hex(ab: ArrayBuffer): Promise<string> {
  return sha256(ab);
}

/** A vault-relative path with a non-secret international segment (kept per language rules). */
export const INTL_PATH = 'メモ/テスト 🗂️.md';

/** Megabyte in bytes. */
export const MB = 1024 * 1024;

let counter = 0;
/** A unique vault-relative file path for a test (avoids collisions within a run). */
export function uniquePath(prefix = 'note', ext = 'md'): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}.${ext}`;
}
