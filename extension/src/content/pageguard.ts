// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

// Runs in the page's own JavaScript world (manifest `"world": "MAIN"`) at
// document_start, before any page script. It changes how the page's
// listeners are added so that a page key, focus or mouse listener does not
// run for an event aimed inside the Gloss UI. This keeps page shortcuts
// (Jira's "a" and "w", GitHub's "s") from firing while the reader types in
// the composer.
//
// The window listeners of guard.ts do the same job but depend on being
// added first, and a page that calls `document.open()` while it loads (Jira
// does) erases every window and document listener, theirs included. This
// script changes `EventTarget.prototype` instead, which `document.open()`
// leaves in place, so it holds whatever order listeners are added in.
//
// A browser that ignores `world` runs this file in the content scripts'
// world, where wrapping listeners would also wrap the Gloss UI's own; there
// `runtime.id` is defined, and the script does nothing.

import { GUARDED_EVENTS } from './events';
import { HOST_TAG } from './text';

type RuntimeHolder = {
	chrome?: { runtime?: { id?: string } };
	browser?: { runtime?: { id?: string } };
};
const g = globalThis as unknown as RuntimeHolder;

if (!g.chrome?.runtime?.id && !g.browser?.runtime?.id) {
	const guarded = new Set(GUARDED_EVENTS);
	const proto = EventTarget.prototype;
	const add = proto.addEventListener;
	const remove = proto.removeEventListener;
	/** The wrapper each page listener was added as, so removing the listener removes its wrapper. */
	const wrappers = new WeakMap<EventListenerOrEventListenerObject, EventListener>();

	/** True when the event happened inside the Gloss host; from this world its path stops at the host. */
	const aimedAtGloss = (e: Event): boolean => {
		for (const node of e.composedPath()) if ((node as Element).localName === HOST_TAG) return true;
		return false;
	};

	const wrapperOf = (listener: EventListenerOrEventListenerObject): EventListener => {
		let wrapper = wrappers.get(listener);
		if (!wrapper) {
			wrapper = function (this: EventTarget, e: Event) {
				if (aimedAtGloss(e)) return;
				if (typeof listener === 'function') return listener.call(this, e);
				return listener.handleEvent(e);
			};
			wrappers.set(listener, wrapper);
		}
		return wrapper;
	};

	proto.addEventListener = function (
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions
	) {
		if (!listener || !guarded.has(type)) return add.call(this, type, listener, options);
		return add.call(this, type, wrapperOf(listener), options);
	};
	proto.removeEventListener = function (
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions
	) {
		const wrapper = listener && guarded.has(type) ? wrappers.get(listener) : undefined;
		return remove.call(this, type, wrapper ?? listener, options);
	};
}
