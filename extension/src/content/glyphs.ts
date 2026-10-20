// The small quote marks that sit beside each asked passage. Glyphs
// live inside the extension's shadow root in a layer positioned at the
// document origin, so their coordinates are page coordinates. The layer
// re-measures every range on scroll, resize, body size changes and DOM
// mutations, and reports ranges that no longer point at live text.

/** Width of a mark in CSS pixels, matching `.gloss-glyph` in styles.css. */
const GLYPH_WIDTH = 16;
/** Space between the text block's edge and the nearest mark. */
const GUTTER_GAP = 6;

import { MARK_SVG } from '../shared/mark';

/** The first laid-out rect of a range, or null when it has none. */
function firstRect(range: Range): DOMRect | null {
	for (const r of range.getClientRects()) if (r.width > 0 || r.height > 0) return r;
	return null;
}

/** The last laid-out rect of a range, or null when it has none. */
function lastRect(range: Range): DOMRect | null {
	const rects = range.getClientRects();
	for (let i = rects.length - 1; i >= 0; i--) if (rects[i].width > 0 || rects[i].height > 0) return rects[i];
	return null;
}

/** The nearest block-level element around a range, whose margins hold the mark. */
function blockOf(range: Range): Element | null {
	let el: Element | null =
		range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
			? (range.commonAncestorContainer as Element)
			: range.commonAncestorContainer.parentElement;
	const win = el?.ownerDocument.defaultView;
	while (el && win) {
		const display = win.getComputedStyle(el).display;
		if (display !== 'inline' && display !== 'contents' && !display.startsWith('inline-')) return el;
		el = el.parentElement;
	}
	return null;
}

export interface GlyphOptions {
	/** Dimmed: the ask is collapsed. */
	open: boolean;
	/** The popover for this ask is showing. */
	active: boolean;
	fuzzy: boolean;
}

interface Glyph {
	el: HTMLButtonElement;
	range: Range;
	options: GlyphOptions;
}

export interface GlyphLayerHandlers {
	onClick(id: string): void;
	/** The range of this ask no longer points at live text; it needs resolving again. */
	onDetached(id: string): void;
	/** Positions were refreshed; the popover re-reads its anchor rect. */
	onReposition(): void;
}

const MUTATION_DEBOUNCE_MS = 250;

export class GlyphLayer {
	private readonly glyphs = new Map<string, Glyph>();
	private frame: number | null = null;
	private mutationTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly resize: ResizeObserver | null;
	private readonly mutations: MutationObserver | null;

	constructor(
		private readonly container: HTMLElement,
		private readonly handlers: GlyphLayerHandlers,
		private readonly win: Window = window,
	) {
		this.schedule = this.schedule.bind(this);
		win.addEventListener('scroll', this.schedule, { capture: true, passive: true });
		win.addEventListener('resize', this.schedule, { passive: true });
		this.resize = typeof ResizeObserver === 'function' ? new ResizeObserver(this.schedule) : null;
		this.resize?.observe(win.document.body);
		this.mutations =
			typeof MutationObserver === 'function'
				? new MutationObserver(() => {
						if (this.mutationTimer) clearTimeout(this.mutationTimer);
						this.mutationTimer = setTimeout(() => {
							this.mutationTimer = null;
							this.reposition();
						}, MUTATION_DEBOUNCE_MS);
					})
				: null;
		this.mutations?.observe(win.document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'style', 'class'] });
	}

	/** True once the DOM has been mutated since the last reposition; the index needs rebuilding. */
	get dirty(): boolean {
		return this.mutationTimer !== null;
	}

	set(id: string, range: Range, options: GlyphOptions): void {
		let g = this.glyphs.get(id);
		if (!g) {
			const el = this.win.document.createElement('button');
			el.type = 'button';
			el.className = 'gloss-glyph';
			el.setAttribute('aria-label', 'Gloss note');
			el.innerHTML = MARK_SVG;
			el.addEventListener('mousedown', (e) => e.preventDefault());
			el.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.handlers.onClick(id);
			});
			this.container.appendChild(el);
			g = { el, range, options };
			this.glyphs.set(id, g);
		}
		g.range = range;
		g.options = options;
		this.apply(g);
		this.place(id, g);
	}

	update(id: string, options: Partial<GlyphOptions>): void {
		const g = this.glyphs.get(id);
		if (!g) return;
		g.options = { ...g.options, ...options };
		this.apply(g);
	}

	remove(id: string): void {
		const g = this.glyphs.get(id);
		if (!g) return;
		g.el.remove();
		this.glyphs.delete(id);
	}

	clear(): void {
		for (const g of this.glyphs.values()) g.el.remove();
		this.glyphs.clear();
	}

	has(id: string): boolean {
		return this.glyphs.has(id);
	}

	/** The viewport rect of the glyph; null when the ask has no glyph. */
	rectOf(id: string): DOMRect | null {
		const g = this.glyphs.get(id);
		if (!g || g.el.hidden) return null;
		return g.el.getBoundingClientRect();
	}

	/**
	 * The viewport rect of the passage's last line, which the popover hangs
	 * from so it opens by the text rather than by the mark in the margin.
	 * Null when the passage is not laid out.
	 */
	passageRectOf(id: string): DOMRect | null {
		const g = this.glyphs.get(id);
		if (!g || g.el.hidden) return null;
		return lastRect(g.range);
	}

	/** The ask whose highlighted passage contains the viewport point, if any. */
	askAt(x: number, y: number): string | null {
		for (const [id, g] of this.glyphs) {
			if (g.el.hidden) continue;
			for (const r of g.range.getClientRects()) {
				if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id;
			}
		}
		return null;
	}

	/** Scrolls the passage to the middle of the viewport, unless it is already well inside it. */
	scrollTo(id: string): void {
		const g = this.glyphs.get(id);
		if (!g) return;
		const first = firstRect(g.range);
		const last = lastRect(g.range);
		const margin = 48;
		if (first && last && first.top >= margin && last.bottom <= this.win.innerHeight - margin) return;
		const el = g.range.startContainer.nodeType === Node.ELEMENT_NODE ? (g.range.startContainer as Element) : g.range.startContainer.parentElement;
		el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
	}

	/** Re-measures every glyph on the next animation frame. */
	schedule(): void {
		if (this.frame !== null) return;
		this.frame = this.win.requestAnimationFrame(() => {
			this.frame = null;
			this.reposition();
		});
	}

	reposition(): void {
		const taken = new Map<number, number>();
		for (const [id, g] of this.glyphs) this.place(id, g, taken);
		this.handlers.onReposition();
	}

	dispose(): void {
		this.clear();
		this.win.removeEventListener('scroll', this.schedule, { capture: true });
		this.win.removeEventListener('resize', this.schedule);
		this.resize?.disconnect();
		this.mutations?.disconnect();
		if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
		if (this.mutationTimer) clearTimeout(this.mutationTimer);
	}

	private apply(g: Glyph): void {
		g.el.classList.toggle('is-collapsed', !g.options.open);
		g.el.classList.toggle('is-active', g.options.active);
		g.el.classList.toggle('is-fuzzy', g.options.fuzzy);
	}

	private place(id: string, g: Glyph, taken: Map<number, number> = new Map()): void {
		const range = g.range;
		const doc = this.win.document;
		if (range.collapsed || !doc.contains(range.startContainer) || !doc.contains(range.endContainer)) {
			g.el.hidden = true;
			this.handlers.onDetached(id);
			return;
		}
		const first = firstRect(range);
		const last = lastRect(range);
		if (!first || !last) {
			g.el.hidden = true;
			this.handlers.onDetached(id);
			return;
		}
		g.el.hidden = false;
		const spot = this.gutterSpot(range, first, last, taken);
		g.el.classList.toggle('in-gutter', spot.gutter);
		g.el.classList.toggle('is-raised', !spot.gutter);
		g.el.style.transform = `translate(${Math.round(spot.x + this.win.scrollX)}px, ${Math.round(spot.y + this.win.scrollY)}px)`;
		g.el.style.height = spot.gutter ? `${Math.max(14, Math.round(first.height))}px` : '';
	}

	/**
	 * Where the mark goes. It sits in the margin beside the passage's first
	 * line, on the left when the text block leaves room there and on the
	 * right otherwise, so it never runs into the words that follow the
	 * passage. Marks that would share a line step outward. When neither
	 * margin has room (text set edge to edge) the mark is raised a little
	 * above the end of the passage instead, like a footnote number.
	 */
	private gutterSpot(range: Range, first: DOMRect, last: DOMRect, taken: Map<number, number>): { x: number; y: number; gutter: boolean } {
		const block = blockOf(range);
		const viewportWidth = this.win.innerWidth;
		if (block) {
			const box = block.getBoundingClientRect();
			const style = this.win.getComputedStyle(block);
			const left = box.left + (parseFloat(style.paddingLeft) || 0);
			const right = box.right - (parseFloat(style.paddingRight) || 0);
			const row = Math.round(first.top / 4);
			const n = taken.get(row) ?? 0;
			taken.set(row, n + 1);
			if (left >= GLYPH_WIDTH + GUTTER_GAP) {
				return { x: left - GUTTER_GAP - GLYPH_WIDTH * (n + 1), y: first.top, gutter: true };
			}
			if (viewportWidth - right >= GLYPH_WIDTH + GUTTER_GAP) {
				return { x: right + GUTTER_GAP + GLYPH_WIDTH * n, y: first.top, gutter: true };
			}
		}
		return { x: last.right - 3, y: last.top - 5, gutter: false };
	}
}
