// Copy shared between rows or too long to sit inline. UI strings are English.
// Wording lives in `desc` rather than tooltips: the declarative settings API has no tooltip field and mobile cannot hover.

// The 405 case is stated explicitly because it is the most common setup mistake (GitHub issue #35): a bare host answers PROPFIND at the server root.
export const SERVER_URL_DESC =
  'Full Nextcloud WebDAV endpoint: https://<host>/remote.php/dav/files/<user>/ (a trailing subfolder is allowed). Just the host (e.g. https://cloud.example.com) is not enough and fails with HTTP 405.';

// Explains the sign-in model first: without it, the absence of a "login" button reads as an unfinished form.
export const SIGN_IN_HELP =
  'There is no separate "login" step. Either log in via browser (recommended) or fill in the username and app password below — the two are alternatives, not both.';

export const SIGN_IN_MANUAL_DIVIDER = 'Or sign in manually:';
