// The events the content script keeps from the page and the names under
// which guard.ts and the main content script share the guard.

/**
 * Events the page never sees when they happen inside the Gloss UI: the
 * ones focus-trap libraries watch and the three key events that page
 * shortcut handlers bind (single-letter shortcuts mostly use keypress),
 * see `guardEvent` in index.ts. Nothing is guarded while no Gloss UI is
 * showing, since only events aimed inside it are affected.
 */
export const GUARDED_EVENTS = ['focusin', 'focusout', 'focus', 'blur', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'keydown', 'keypress', 'keyup'];

/** Global property holding the main content script's guard function. */
export const GUARD_KEY = '__glossEventGuard';
/** Global property set once guard.ts has added its window listeners. */
export const GUARD_READY_KEY = '__glossEventGuardReady';

export type GuardHolder = typeof globalThis & {
	[GUARD_KEY]?: (e: Event) => void;
	[GUARD_READY_KEY]?: boolean;
};
