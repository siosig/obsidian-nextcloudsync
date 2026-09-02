import { FileState, RemoteFileInfo } from '../types';

/**
 * The identity of a file as it currently exists on the server (feature 080).
 *
 * This is the single definition of "what does the remote side of this file look like right now". It
 * existed in three places before, written out by hand each time, and a fourth rule — a different one —
 * decided what to record after an upload. That disagreement is the whole of the bug this module
 * exists to close: on a plain WebDAV server the recording side wrote a SHA-256 while the classifying
 * side read an ETag, so every file the plugin uploaded read back as "changed by someone else" and,
 * if the user was still editing, resolved as a conflict over their text.
 *
 * The rule itself is unchanged: prefer the server's checksum, fall back to the validator, and fall
 * back again to the size for servers that offer neither. What changed is that there is now one copy
 * of it, so the recording side can be made to use the same one rather than a parallel rule of its own.
 *
 * One inconsistency was fixed in the merge: the size fallback previously reported `idType: 'etag'` at
 * one of the three call sites, labelling a byte count as a validator.
 */
export function remoteIdOf(remote: RemoteFileInfo): { remoteId: string; idType: FileState['idType'] } {
  if (remote.checksum) return { remoteId: remote.checksum, idType: 'sha256' };
  if (remote.etag) return { remoteId: remote.etag, idType: 'etag' };
  return { remoteId: String(remote.size), idType: 'size' };
}
