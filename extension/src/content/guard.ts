// The first content script, run at document_start before any page script.
// The browser calls listeners on the same target and phase in the order
// they were added, so the window capture listeners added here run before
// every listener a page adds, including shortcut handlers a page puts on
// the window in the capture phase while it loads (Jira does). Each one
// hands the event to the guard the main content script installs once it
// starts; until then, and on pages where it never starts, they do nothing.
// Content scripts of one extension share a global object, which is how the
// two scripts meet.

import { GUARD_ALIVE_KEY, GUARD_KEY, GUARD_PROBE, GUARD_READY_KEY, GUARDED_EVENTS, type GuardHolder } from './events';

const holder = globalThis as GuardHolder;
if (!holder[GUARD_READY_KEY]) {
	holder[GUARD_READY_KEY] = true;
	for (const type of GUARDED_EVENTS) window.addEventListener(type, (e) => holder[GUARD_KEY]?.(e), true);
	window.addEventListener(GUARD_PROBE, () => (holder[GUARD_ALIVE_KEY] = true), true);
}
