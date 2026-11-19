/**
 * The drawer layout: narrow screens, and a phone turned sideways, which is wide but short.
 * Tablets in landscape are taller than 500px and keep the desktop sidebar. CSS cannot import
 * this, so the drawer rules in styles.css, Sidebar.css and RenamePaneButton.css repeat it
 * word for word; change them together.
 */
export const PHONE_DRAWER_QUERY = "(max-width: 768px), (pointer: coarse) and (max-height: 500px)";
