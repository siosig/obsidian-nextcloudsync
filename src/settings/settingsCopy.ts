// Settings copy that is shared between rows, or long enough to be worth naming. UI strings are
// English.
//
// This replaces tooltips.ts (feature 077). Tooltips were hover-only, so on mobile 23 rows' worth of
// supplementary help — defaults, ranges, units, examples, common mistakes — was written but never
// shown to anyone. Obsidian's declarative settings API has no tooltip field, and the choice was
// between keeping the rows imperative to preserve a desktop-only affordance or folding the wording
// into `desc`, where every platform can read it. The wording moved into `desc`; what survives here
// is only the copy that more than one row needs or that is too long to sit inline.

/**
 * Always-visible Server URL description. The 405 case is stated explicitly because it is the single
 * most common setup mistake (GitHub issue #35): a bare host answers PROPFIND at the server root.
 */
export const SERVER_URL_DESC =
  'Full Nextcloud WebDAV endpoint: https://<host>/remote.php/dav/files/<user>/ (a trailing subfolder is allowed). Just the host (e.g. https://cloud.example.com) is not enough and fails with HTTP 405.';

/**
 * Explains the sign-in model before the two credential paths, because the absence of a "login"
 * button reads as an unfinished form otherwise.
 */
export const SIGN_IN_HELP =
  'There is no separate "login" step. Either log in via browser (recommended) or fill in the username and app password below — the two are alternatives, not both.';

/** Divider between the recommended browser sign-in and the manual fields. */
export const SIGN_IN_MANUAL_DIVIDER = 'Or sign in manually:';
