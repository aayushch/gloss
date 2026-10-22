// Where a passage sits on the page, kept while its text is on the page so
// the navigator can scroll back to it after a page that renders only what
// is on screen (long logs, feeds, virtual lists) has removed it. The spot is
// measured inside the passage's nearest scrolling box, since such pages
// usually scroll an inner box rather than the page itself.

import type { AskEntry } from './state';

export interface PassageSpot {
	/** The nearest scrolling ancestor of the passage; null when the page itself scrolls it. */
	scroller: Element | null;
	/**
	 * The top of the passage's first line measured from the top of the
	 * scroller's content (its scrolled-out part included); for the page,
	 * its document y. Scrolling does not change it.
	 */
	offset: number;
}

/** The first laid-out rect of a range, or null when it has none. */
function firstRect(range: Range): DOMRect | null {
	for (const r of range.getClientRects()) if (r.width > 0 || r.height > 0) return r;
	return null;
}

/** The nearest ancestor that scrolls its content vertically, or null for the page. */
function scrollerOf(node: Node): Element | null {
	const doc = node.ownerDocument;
	const win = doc?.defaultView;
	let el: Element | null = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	for (; el && win && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
		const overflow = win.getComputedStyle(el).overflowY;
		if ((overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') && el.scrollHeight > el.clientHeight) return el;
	}
	return null;
}

/**
 * The spot of a laid-out passage, or null when it has no layout. The
 * scroller found for `previous` is kept while it still holds the passage,
 * so the ancestors are walked once rather than on every scroll.
 */
export function spotOf(range: Range, previous: PassageSpot | null): PassageSpot | null {
	const rect = firstRect(range);
	if (!rect) return null;
	const win = range.startContainer.ownerDocument?.defaultView ?? window;
	const kept = previous && (previous.scroller === null || (previous.scroller.isConnected && previous.scroller.contains(range.startContainer)));
	const scroller = kept ? previous.scroller : scrollerOf(range.startContainer);
	if (!scroller) return { scroller: null, offset: rect.top + win.scrollY };
	return { scroller, offset: rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop };
}

/** The document y of a spot, or null when its scroller has left the page. */
export function documentY(spot: PassageSpot): number | null {
	if (!spot.scroller) return spot.offset;
	if (!spot.scroller.isConnected) return null;
	return spot.scroller.getBoundingClientRect().top + window.scrollY - spot.scroller.scrollTop + spot.offset;
}

/**
 * Scrolls a spot to the middle of the view at once, without smooth
 * scrolling, so a page that renders only what is on screen puts the
 * passage back right away. False when its scroller has left the page.
 */
export function scrollToSpot(spot: PassageSpot): boolean {
	if (!spot.scroller) {
		window.scrollTo({ top: Math.max(0, spot.offset - window.innerHeight / 2) });
		return true;
	}
	if (!spot.scroller.isConnected) return false;
	spot.scroller.scrollIntoView({ block: 'nearest' });
	spot.scroller.scrollTop = Math.max(0, spot.offset - spot.scroller.clientHeight / 2);
	return true;
}

/**
 * Where an ask comes in reading order: the document y of its passage,
 * measured live while the passage is on the page and taken from its last
 * spot while it is detached. Null for asks never found on this visit.
 */
export function passageY(entry: AskEntry): number | null {
	if (entry.range && (entry.state === 'anchored' || entry.state === 'fuzzy')) {
		const rect = firstRect(entry.range);
		if (rect) return rect.top + window.scrollY;
	}
	return entry.spot ? documentY(entry.spot) : null;
}
