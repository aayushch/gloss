// Where the note navigator sits on the page. It always docks on the right
// edge of the viewport, at a height the reader can change by dragging it
// (stored for all sites as a fraction of the viewport height, the middle by
// default). The only thing that moves it off that height is an element
// pinned to the screen under it, such as a chat button, cookie banner or
// sticky sidebar; it then slides along the right edge to the nearest height
// where nothing pinned is underneath. Content that scrolls with the page is
// ignored, since scrolling moves it away. The position is worked out when
// the navigator appears, when the window is resized and when the page adds
// elements (widgets often load late), never while the page scrolls.

/** Size of the navigator in CSS pixels, matching `.gloss-nav` in styles.css. */
export const NAV_WIDTH = 108;
export const NAV_HEIGHT = 30;
/** Distance from the viewport edges. */
const EDGE = 16;
/** Extra room around the navigator that must be clear too, so it never sits flush against a widget. */
const CLEARANCE = 6;
/** Spacing of the heights tried when the navigator has to slide. */
const ROW_STEP = 4;
/** How long the page must stay unchanged before the position is worked out again. */
const SETTLE_MS = 250;
/** Pages that load widgets late are checked again on this schedule after the navigator appears. */
const LATE_CHECK_MS = [1_000, 3_000];
/** The reader's height for the navigator, the default in the middle. */
export const DEFAULT_HEIGHT_FRACTION = 0.5;

export interface DockPosition {
	/** Viewport coordinates of the navigator's top-left corner. */
	left: number;
	top: number;
}

/** The topmost page element at a viewport point, leaving out the Gloss UI. */
export type HitTest = (x: number, y: number) => Element | null;

/** Elements a reader clicks, types into or plays. */
const INTERACTIVE = [
	'a[href]',
	'button',
	'input',
	'select',
	'textarea',
	'label',
	'summary',
	'iframe',
	'video',
	'audio',
	'[contenteditable]:not([contenteditable="false"])',
	'[onclick]',
	'[tabindex]:not([tabindex="-1"])',
	'[role="button"]',
	'[role="link"]',
	'[role="menuitem"]',
	'[role="tab"]',
	'[role="checkbox"]',
	'[role="switch"]',
	'[role="textbox"]',
].join(',');

/** Cost of covering a control inside a pinned element. */
const COVERS_PINNED_CONTROL = 10;
/** Cost of covering any other part of a pinned element. */
const COVERS_PINNED = 4;

/** The top of the navigator's range of heights and the length of that range. */
function heightRange(viewportHeight: number): { min: number; span: number } {
	return { min: EDGE, span: Math.max(0, viewportHeight - NAV_HEIGHT - 2 * EDGE) };
}

/** The viewport top for a height fraction (0 at the top of the range, 1 at the bottom). */
export function topOf(fraction: number, viewportHeight: number): number {
	const { min, span } = heightRange(viewportHeight);
	return Math.round(min + Math.min(1, Math.max(0, fraction)) * span);
}

/** The height fraction of a viewport top, the inverse of `topOf`. */
export function fractionOf(top: number, viewportHeight: number): number {
	const { min, span } = heightRange(viewportHeight);
	return span > 0 ? Math.min(1, Math.max(0, (top - min) / span)) : DEFAULT_HEIGHT_FRACTION;
}

/**
 * What covering this element would cost the reader. Only elements pinned
 * to the screen (fixed or sticky, or inside one) count; everything else
 * scrolls out from under the navigator and costs 0.
 */
export function obstruction(el: Element | null): number {
	if (!el) return 0;
	const doc = el.ownerDocument;
	const win = doc.defaultView;
	if (!win || el === doc.documentElement || el === doc.body) return 0;
	for (let node: Element | null = el; node && node !== doc.body; node = node.parentElement) {
		const position = win.getComputedStyle(node).position;
		if (position === 'fixed' || position === 'sticky') return el.closest(INTERACTIVE) ? COVERS_PINNED_CONTROL : COVERS_PINNED;
	}
	return 0;
}

/**
 * The navigator's position on the right edge. It keeps the reader's height
 * when nothing pinned is under it there; otherwise it takes the nearest
 * clear height, or the least covered one when no height is clear.
 */
export function placeOnEdge(viewportWidth: number, viewportHeight: number, fraction: number, hit: HitTest): DockPosition {
	const left = viewportWidth - NAV_WIDTH - EDGE;
	const xs = [left - CLEARANCE, left + NAV_WIDTH / 2, left + NAV_WIDTH + CLEARANCE];
	const preferred = topOf(fraction, viewportHeight);
	const rowCost = new Map<number, number>();
	const costOfRow = (y: number): number => {
		let cost = rowCost.get(y);
		if (cost === undefined) {
			cost = 0;
			for (const x of xs) cost += obstruction(hit(x, y));
			rowCost.set(y, cost);
		}
		return cost;
	};
	const costAt = (top: number): number => {
		let cost = 0;
		for (let y = top - CLEARANCE; y <= top + NAV_HEIGHT + CLEARANCE; y += ROW_STEP) cost += costOfRow(Math.round(y));
		return cost;
	};

	if (costAt(preferred) === 0) return { left, top: preferred };
	const { min, span } = heightRange(viewportHeight);
	const max = min + span;
	let best = preferred;
	let bestCost = costAt(preferred);
	// Tries heights ever further above and below the preferred one; the first clear one is the nearest.
	for (let d = ROW_STEP; preferred - d >= min || preferred + d <= max; d += ROW_STEP) {
		for (const top of [preferred - d, preferred + d]) {
			if (top < min || top > max) continue;
			const cost = costAt(top);
			if (cost === 0) return { left, top };
			if (cost < bestCost) {
				best = top;
				bestCost = cost;
			}
		}
	}
	return { left, top: best };
}

/**
 * Keeps the navigator's position up to date while it is shown. `isHeld`
 * reports that the reader is pointing at, focused in or dragging the
 * navigator, when it must not move out from under them.
 */
export class Dock {
	private shown = false;
	private fraction = DEFAULT_HEIGHT_FRACTION;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private lateTimers: ReturnType<typeof setTimeout>[] = [];
	private readonly mutations: MutationObserver | null;

	constructor(
		private readonly hit: HitTest,
		private readonly onMove: (pos: DockPosition) => void,
		private readonly isHeld: () => boolean,
		private readonly win: Window = window,
	) {
		this.settle = this.settle.bind(this);
		this.mutations = typeof MutationObserver === 'function' ? new MutationObserver(this.settle) : null;
	}

	/** The viewport size the navigator is placed in; clientWidth leaves out a classic scrollbar, which innerWidth includes. */
	viewport(): { width: number; height: number } {
		const root = this.win.document.documentElement;
		return {
			width: root.clientWidth || this.win.innerWidth,
			height: Math.min(this.win.innerHeight, root.clientHeight || this.win.innerHeight),
		};
	}

	/** Sets the reader's height and places the navigator there again. */
	setFraction(fraction: number): void {
		this.fraction = fraction;
		this.measure(true);
	}

	show(): void {
		if (this.shown) return;
		this.shown = true;
		this.win.addEventListener('resize', this.settle, { passive: true });
		this.mutations?.observe(this.win.document.body, { childList: true, subtree: true });
		this.measure();
		this.lateTimers = LATE_CHECK_MS.map((ms) => setTimeout(() => this.measure(), ms));
	}

	hide(): void {
		if (!this.shown) return;
		this.shown = false;
		this.win.removeEventListener('resize', this.settle);
		this.mutations?.disconnect();
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		for (const t of this.lateTimers) clearTimeout(t);
		this.lateTimers = [];
	}

	/** Works the position out again once the page has been unchanged for a moment. */
	private settle(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			this.measure();
		}, SETTLE_MS);
	}

	/** `force` places it even while held, for the drop at the end of a drag. */
	private measure(force = false): void {
		if (!this.shown || (!force && this.isHeld())) return;
		const { width, height } = this.viewport();
		this.onMove(placeOnEdge(width, height, this.fraction, this.hit));
	}
}
