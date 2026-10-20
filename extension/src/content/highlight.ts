// Paints asked passages with the CSS Custom Highlight API. Two named
// highlights exist: `gloss-ask` for every anchored passage and
// `gloss-ask-active` for the one whose popover is open. Where the API is
// missing the layer does nothing and passages stay unmarked.

const HIGHLIGHT_CSS = `
::highlight(gloss-ask) { background-color: rgba(194, 65, 12, 0.16); text-decoration: underline; text-decoration-color: rgba(194, 65, 12, 0.6); text-decoration-thickness: 1px; text-underline-offset: 2px; }
::highlight(gloss-ask-active) { background-color: rgba(194, 65, 12, 0.32); }
@media (prefers-color-scheme: dark) {
  ::highlight(gloss-ask) { background-color: rgba(251, 146, 60, 0.22); text-decoration-color: rgba(251, 146, 60, 0.7); }
  ::highlight(gloss-ask-active) { background-color: rgba(251, 146, 60, 0.4); }
}`;

interface HighlightRegistry {
	set(name: string, h: Highlight): void;
	delete(name: string): void;
}

declare class Highlight {
	constructor(...ranges: AbstractRange[]);
	add(range: AbstractRange): this;
	delete(range: AbstractRange): boolean;
	clear(): void;
}

export function supportsHighlights(): boolean {
	return typeof Highlight === 'function' && typeof CSS !== 'undefined' && 'highlights' in CSS;
}

export class HighlightLayer {
	private readonly all: Highlight | null = null;
	private readonly active: Highlight | null = null;
	private activeRange: Range | null = null;
	private sheet: CSSStyleSheet | null = null;

	constructor(private readonly doc: Document) {
		if (!supportsHighlights()) return;
		this.all = new Highlight();
		this.active = new Highlight();
		const registry = (CSS as unknown as { highlights: HighlightRegistry }).highlights;
		registry.set('gloss-ask', this.all);
		registry.set('gloss-ask-active', this.active);
		try {
			this.sheet = new CSSStyleSheet();
			this.sheet.replaceSync(HIGHLIGHT_CSS);
			doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, this.sheet];
		} catch {
			this.sheet = null;
		}
	}

	add(range: Range): void {
		this.all?.add(range);
	}

	remove(range: Range): void {
		this.all?.delete(range);
		if (this.activeRange === range) this.setActive(null);
	}

	/** Marks the passage whose popover is open; null clears the mark. */
	setActive(range: Range | null): void {
		if (!this.active) return;
		this.active.clear();
		this.activeRange = range;
		if (range) this.active.add(range);
	}

	clear(): void {
		this.all?.clear();
		this.active?.clear();
		this.activeRange = null;
	}

	/** Removes the highlights and the stylesheet from the document. */
	dispose(): void {
		this.clear();
		if (!supportsHighlights()) return;
		const registry = (CSS as unknown as { highlights: HighlightRegistry }).highlights;
		registry.delete('gloss-ask');
		registry.delete('gloss-ask-active');
		if (this.sheet) this.doc.adoptedStyleSheets = this.doc.adoptedStyleSheets.filter((s) => s !== this.sheet);
	}
}
