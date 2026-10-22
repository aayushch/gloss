// Keeps the page from seeing what happens inside the Gloss UI. Modal
// dialogs trap focus: their libraries listen on the document, often in the
// capture phase, cancel presses outside the dialog and pull focus back,
// which would make the composer's box impossible to type into. Keyboard
// shortcuts are the other case: the page sees a key typed in the composer
// as typed on the host element, not in a text box, and runs the shortcut
// for that letter (GitHub opens search on "s", Jira has one for most
// letters).
//
// `handle` runs as the first window capture listener (see guard.ts). A
// trusted event aimed inside the host is stopped there, and a copy that
// does not leave the shadow tree is dispatched in its place at the element
// inside the UI it was aimed at. The copy reaches every listener of the
// Gloss UI; when one of them cancels it, the original is cancelled too so
// the browser's default action follows. Stopping the original does not
// stop its default action, so typed characters still reach the text box.

export class UiGuard {
	/** True while `handle` dispatches its copy of an event. */
	private replaying = false;
	/** The element inside the UI that last received focus, which a focusout or blur leaving it is aimed at. */
	private focused: Element | null = null;

	/**
	 * `beforeKeydown` sees each guarded keydown's copy before the element
	 * it was aimed at does, as a document capture listener would.
	 */
	constructor(
		private readonly host: Element,
		private readonly shadow: ShadowRoot,
		private readonly beforeKeydown: (e: KeyboardEvent) => void,
	) {}

	readonly handle = (e: Event): void => {
		if (!e.isTrusted || this.replaying) return;
		if (!e.composedPath().includes(this.host)) return;
		const target = this.innerTarget(e);
		if (e.type === 'focusin' || e.type === 'focus') this.focused = target;
		if (!target) return;
		let copy: Event;
		try {
			const init: Record<string, unknown> = {};
			for (const key in e) init[key] = (e as unknown as Record<string, unknown>)[key];
			init.bubbles = true;
			init.composed = false;
			init.cancelable = e.cancelable;
			copy = new (e.constructor as new (type: string, init: Record<string, unknown>) => Event)(e.type, init);
		} catch {
			return;
		}
		e.stopImmediatePropagation();
		this.replaying = true;
		try {
			if (e.type === 'keydown') this.beforeKeydown(copy as KeyboardEvent);
			target.dispatchEvent(copy);
		} finally {
			this.replaying = false;
		}
		if (copy.defaultPrevented) e.preventDefault();
	};

	/**
	 * The element inside the UI that an event is aimed at. The shadow root
	 * is closed, so from the window both `e.target` and `composedPath()`
	 * stop at the host; the element is found from the shadow root instead.
	 * Keys go to the focused element, and so does a click made with the
	 * keyboard (its `detail` is 0). Focus arriving goes to the newly focused
	 * element, focus leaving to the one that had it, and every other press
	 * or click to the element under the pointer. Null when none of these is
	 * inside the UI.
	 */
	private innerTarget(e: Event): Element | null {
		const inside = (el: Element | null) => (el && el !== this.host && this.shadow.contains(el) ? el : null);
		switch (e.type) {
			case 'keydown':
			case 'keypress':
			case 'keyup':
			case 'focusin':
			case 'focus':
				return inside(this.shadow.activeElement);
			case 'focusout':
			case 'blur':
				return inside(this.focused);
			default: {
				const m = e as MouseEvent;
				if (e.type === 'click' && m.detail === 0) return inside(this.shadow.activeElement);
				return inside(this.shadow.elementFromPoint(m.clientX, m.clientY));
			}
		}
	}
}
