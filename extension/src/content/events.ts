// The events the content script keeps from the page and the names under
// which guard.ts and the main content script share the guard.

/**
 * Events the page never sees when they happen inside the Gloss UI: the
 * ones focus-trap libraries watch and the three key events that page
 * shortcut handlers bind (single-letter shortcuts mostly use keypress),
 * see `UiGuard` in uiguard.ts. Nothing is guarded while no Gloss UI is
 * showing, since only events aimed inside it are affected.
 */
export const GUARDED_EVENTS = ['focusin', 'focusout', 'focus', 'blur', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'keydown', 'keypress', 'keyup'];

/** Global property holding the main content script's guard function. */
export const GUARD_KEY = '__glossEventGuard';
/** Global property set once guard.ts has added its window listeners. */
export const GUARD_READY_KEY = '__glossEventGuardReady';
/**
 * An event guard.ts answers by setting `GUARD_ALIVE_KEY`. A page that calls
 * `document.open()` erases guard.ts's window listeners, and this is how the
 * main content script finds out they are gone.
 */
export const GUARD_PROBE = 'gloss-guard-probe';
export const GUARD_ALIVE_KEY = '__glossEventGuardAlive';

export type GuardHolder = typeof globalThis & {
	[GUARD_KEY]?: (e: Event) => void;
	[GUARD_READY_KEY]?: boolean;
	[GUARD_ALIVE_KEY]?: boolean;
};

/** True while guard.ts's window listeners are still in place. */
export function guardListening(): boolean {
	const holder = globalThis as GuardHolder;
	if (!holder[GUARD_READY_KEY]) return false;
	holder[GUARD_ALIVE_KEY] = false;
	window.dispatchEvent(new Event(GUARD_PROBE));
	// The probe's listener in guard.ts sets the flag during the dispatch.
	return (holder as { [GUARD_ALIVE_KEY]?: boolean })[GUARD_ALIVE_KEY] === true;
}
