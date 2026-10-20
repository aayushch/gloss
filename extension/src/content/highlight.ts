// Paints asked passages with rounded tinted boxes, one per line of the
// passage, drawn in the extension's shadow root over the page text: the
// same look the Gloss app gives a quoted span. The boxes let pointer
// events through, so selecting or clicking the text underneath works as
// before. The layer sits at the document origin, so each box is placed in
// page coordinates and stays put while the page scrolls; it is repainted
// whenever the glyph layer re-measures (scroll, resize, DOM changes).

/** A box in viewport coordinates. */
export interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** How far apart (px) two rects on one line may be and still be one box. */
const JOIN_GAP = 3;

/**
 * Joins the client rects of a range into one box per line. A range yields
 * a rect per text node and inline element, so a line of mixed formatting
 * comes back in pieces that would each get their own rounded corners.
 * Rects are on one line when their vertical spans overlap by more than
 * half of the shorter one; along a line, rects that touch or nearly touch
 * become one box.
 */
export function mergeRects(rects: Iterable<Box>): Box[] {
	const lines: Box[][] = [];
	for (const r of rects) {
		if (r.right <= r.left || r.bottom <= r.top) continue;
		const line = lines.find((l) => sameLine(l[0], r));
		if (line) line.push(r);
		else lines.push([r]);
	}
	lines.sort((a, b) => a[0].top - b[0].top);
	const out: Box[] = [];
	for (const line of lines) {
		line.sort((a, b) => a.left - b.left);
		let box: Box | null = null;
		for (const r of line) {
			if (box && r.left <= box.right + JOIN_GAP) {
				box.right = Math.max(box.right, r.right);
				box.top = Math.min(box.top, r.top);
				box.bottom = Math.max(box.bottom, r.bottom);
			} else {
				box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
				out.push(box);
			}
		}
	}
	return out;
}

function sameLine(a: Box, b: Box): boolean {
	const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
	const shorter = Math.min(a.bottom - a.top, b.bottom - b.top);
	return overlap > shorter / 2;
}

/** The part of `box` inside `clip`, or null when nothing is left. */
export function clipBox(box: Box, clip: Box): Box | null {
	const r = {
		left: Math.max(box.left, clip.left),
		top: Math.max(box.top, clip.top),
		right: Math.min(box.right, clip.right),
		bottom: Math.min(box.bottom, clip.bottom),
	};
	return r.right - r.left > 0.5 && r.bottom - r.top > 0.5 ? r : null;
}

/**
 * The area a range may paint in: everything, cut down by every ancestor
 * that clips its overflow, so a passage scrolled out of a panel does not
 * paint outside it. Transforms and clip paths are not accounted for.
 */
function visibleArea(range: Range, win: Window): Box {
	let clip: Box = { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 };
	const start = range.commonAncestorContainer;
	let el: Element | null = start.nodeType === Node.ELEMENT_NODE ? (start as Element) : start.parentElement;
	const doc = win.document;
	while (el && el !== doc.body && el !== doc.documentElement) {
		const style = win.getComputedStyle(el);
		if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
			const r = el.getBoundingClientRect();
			clip = { left: Math.max(clip.left, r.left), top: Math.max(clip.top, r.top), right: Math.min(clip.right, r.right), bottom: Math.min(clip.bottom, r.bottom) };
		}
		el = el.parentElement;
	}
	return clip;
}

interface Painted {
	range: Range;
	boxes: HTMLElement[];
	active: boolean;
}

export class HighlightLayer {
	private readonly painted = new Map<Range, Painted>();
	private activeRange: Range | null = null;

	constructor(
		private readonly container: HTMLElement,
		private readonly win: Window = window,
	) {}

	add(range: Range): void {
		if (this.painted.has(range)) return;
		const p: Painted = { range, boxes: [], active: false };
		this.painted.set(range, p);
		this.paint(p);
	}

	remove(range: Range): void {
		const p = this.painted.get(range);
		if (!p) return;
		for (const b of p.boxes) b.remove();
		this.painted.delete(range);
		if (this.activeRange === range) this.activeRange = null;
	}

	/** Marks the passage whose popover is open; null clears the mark. */
	setActive(range: Range | null): void {
		this.activeRange = range;
		for (const p of this.painted.values()) {
			p.active = p.range === range;
			for (const b of p.boxes) b.classList.toggle('is-active', p.active);
		}
	}

	/** Re-measures every passage; called whenever the glyphs are re-measured. */
	repaint(): void {
		for (const p of this.painted.values()) this.paint(p);
	}

	clear(): void {
		for (const p of this.painted.values()) for (const b of p.boxes) b.remove();
		this.painted.clear();
		this.activeRange = null;
	}

	dispose(): void {
		this.clear();
	}

	private paint(p: Painted): void {
		const doc = this.win.document;
		const range = p.range;
		let boxes: Box[] = [];
		if (!range.collapsed && doc.contains(range.startContainer) && doc.contains(range.endContainer)) {
			const clip = visibleArea(range, this.win);
			boxes = mergeRects(range.getClientRects())
				.map((b) => clipBox(b, clip))
				.filter((b): b is Box => b !== null);
		}
		while (p.boxes.length > boxes.length) p.boxes.pop()?.remove();
		while (p.boxes.length < boxes.length) {
			const el = doc.createElement('div');
			el.className = 'gloss-hl';
			el.classList.toggle('is-active', p.active);
			this.container.appendChild(el);
			p.boxes.push(el);
		}
		const sx = this.win.scrollX;
		const sy = this.win.scrollY;
		boxes.forEach((b, i) => {
			const el = p.boxes[i];
			el.style.transform = `translate(${Math.round(b.left + sx)}px, ${Math.round(b.top + sy)}px)`;
			el.style.width = `${Math.round(b.right - b.left)}px`;
			el.style.height = `${Math.round(b.bottom - b.top)}px`;
		});
	}
}
