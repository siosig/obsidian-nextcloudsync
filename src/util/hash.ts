/** Compute SHA-256 of an ArrayBuffer and return hex string. */
export async function sha256(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Compute SHA-256 of a UTF-8 string and return hex string. */
export async function sha256String(text: string): Promise<string> {
  const encoder = new TextEncoder();
  return sha256(encoder.encode(text).buffer);
}
