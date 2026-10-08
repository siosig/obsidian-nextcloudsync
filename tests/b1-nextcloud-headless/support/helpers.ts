// Shared fixtures and small builders for the E2E suite. No secrets here.
import { sha256 } from '../../../src/util/hash';

export function textBuf(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

export function decodeBuf(ab: ArrayBuffer): string {
  return new TextDecoder('utf-8').decode(ab);
}

export function bytesBuf(n: number): ArrayBuffer {
  const arr = new Uint8Array(n);
  for (let i = 0; i < n; i++) arr[i] = i % 251;
  return arr.buffer;
}

export function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const ua = new Uint8Array(a);
  const ub = new Uint8Array(b);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

export async function sha256Hex(ab: ArrayBuffer): Promise<string> {
  return sha256(ab);
}

export const INTL_PATH = '\u30e1\u30e2/\u30c6\u30b9\u30c8 🗂️.md';

// Exact repro string from PR #17 (CJK path, independent of INTL_PATH).
export const CJK_PATH = '\u4e2d\u6587\u76ee\u5f55/\u65e5\u8bb0.md';

export const MB = 1024 * 1024;

let counter = 0;
export function uniquePath(prefix = 'note', ext = 'md'): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}.${ext}`;
}
