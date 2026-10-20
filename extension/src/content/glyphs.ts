// The small quote marks that sit at the end of each asked passage. Glyphs
// live inside the extension's shadow root in a layer positioned at the
// document origin, so their coordinates are page coordinates. The layer
// re-measures every range on scroll, resize, body size changes and DOM
// mutations, and reports ranges that no longer point at live text.

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
			el.textContent = '“';
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

	/** The viewport rect of the glyph, for anchoring the popover; null when the ask has no glyph. */
	rectOf(id: string): DOMRect | null {
		const g = this.glyphs.get(id);
		if (!g || g.el.hidden) return null;
		return g.el.getBoundingClientRect();
	}

	/** Scrolls the passage into view. */
	scrollTo(id: string): void {
		const g = this.glyphs.get(id);
		if (!g) return;
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
		for (const [id, g] of this.glyphs) this.place(id, g);
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

	private place(id: string, g: Glyph): void {
		const range = g.range;
		const doc = this.win.document;
		if (range.collapsed || !doc.contains(range.startContainer) || !doc.contains(range.endContainer)) {
			g.el.hidden = true;
			this.handlers.onDetached(id);
			return;
		}
		const rects = range.getClientRects();
		let last: DOMRect | null = null;
		for (let i = rects.length - 1; i >= 0; i--) {
			if (rects[i].width > 0 || rects[i].height > 0) {
				last = rects[i];
				break;
			}
		}
		if (!last) {
			g.el.hidden = true;
			this.handlers.onDetached(id);
			return;
		}
		g.el.hidden = false;
		const x = last.right + this.win.scrollX;
		const y = last.top + this.win.scrollY;
		g.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
		g.el.style.height = `${Math.max(14, Math.round(last.height))}px`;
	}
}
