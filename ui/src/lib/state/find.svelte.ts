// In-conversation find (Cmd/Ctrl+F). Matches are DOM ranges over the text
// the transcript currently renders. A collapsed well renders nothing, so
// once typing pauses the bar asks the app (through `expand`) to open every
// well whose stored text holds the query; the mutation observer then picks
// up the newly rendered matches. Matches are painted with the CSS custom
// highlight API where the webview has it and by selecting the current match
// where it does not.

const HIGHLIGHT_ALL = 'gloss-find';
const HIGHLIGHT_CURRENT = 'gloss-find-current';

/** Text nodes under `root` in document order, leaving out button labels and
 * anything marked `data-nofind`, so "Copy" on a code block never matches. */
function textNodes(root: Node): Text[] {
	const out: Text[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(n) {
			const el = n.parentElement;
			if (!el || el.closest('button, [data-nofind]')) return NodeFilter.FILTER_REJECT;
			return n.textContent ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
		}
	});
	let n: Node | null;
	while ((n = walker.nextNode())) out.push(n as Text);
	return out;
}

/** Every case-insensitive occurrence of `query` in the text under `root`, as
 * ranges in document order. A match may span adjacent text nodes, which is
 * how a bold word inside a sentence is still found. */
export function findRanges(root: Node, query: string): Range[] {
	const q = query.toLowerCase();
	if (!q) return [];
	const nodes = textNodes(root);
	let text = '';
	const starts: number[] = [];
	for (const n of nodes) {
		starts.push(text.length);
		text += n.textContent!.toLowerCase();
	}
	const locate = (offset: number): [Text, number] => {
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (starts[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return [nodes[lo], offset - starts[lo]];
	};
	const out: Range[] = [];
	let i = text.indexOf(q);
	while (i >= 0) {
		const r = document.createRange();
		const [sn, so] = locate(i);
		const [en, eo] = locate(i + q.length - 1);
		r.setStart(sn, so);
		r.setEnd(en, eo + 1);
		out.push(r);
		i = text.indexOf(q, i + q.length);
	}
	return out;
}

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
type HighlightCtor = new (...ranges: Range[]) => unknown;

function highlights(): { registry: HighlightRegistry; Highlight: HighlightCtor } | null {
	const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
	const ctor = (globalThis as { Highlight?: HighlightCtor }).Highlight;
	return css?.highlights && ctor ? { registry: css.highlights, Highlight: ctor } : null;
}

class FindState {
	open = $state(false);
	query = $state('');
	/** Number of matches in the rendered transcript. */
	count = $state(0);
	/** 0-based index of the current match, or -1 with no matches. */
	current = $state(-1);

	/** Opens the collapsed wells whose text contains the query. Set by the
	 * app state, which owns the conversation data. */
	expand: ((query: string) => void) | null = null;

	private root: HTMLElement | null = null;
	private ranges: Range[] = [];
	private observer: MutationObserver | null = null;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private expandTimer: ReturnType<typeof setTimeout> | undefined;

	/** The transcript element to search. Called by the transcript on mount. */
	attach(root: HTMLElement | null): void {
		this.observer?.disconnect();
		this.observer = null;
		this.root = root;
		if (root && this.open) this.observe();
	}

	/** Opens the bar. With `query`, searches it at once; `within` makes the
	 * first match inside that element the current one. Returns the number of
	 * matches found. */
	show(query?: string, within?: HTMLElement | null): number {
		this.open = true;
		if (query !== undefined) this.query = query;
		this.observe();
		this.search();
		this.scheduleExpand();
		if (within && this.ranges.length) {
			const idx = this.ranges.findIndex((r) => within.contains(r.startContainer));
			if (idx >= 0) this.goto(idx);
		}
		return this.count;
	}

	hide(): void {
		this.open = false;
		this.observer?.disconnect();
		this.observer = null;
		clearTimeout(this.refreshTimer);
		clearTimeout(this.expandTimer);
		this.ranges = [];
		this.count = 0;
		this.current = -1;
		this.paint();
	}

	setQuery(q: string): void {
		this.query = q;
		this.search();
		this.scheduleExpand();
	}

	next(): void {
		if (this.ranges.length) this.goto((this.current + 1) % this.ranges.length);
	}

	prev(): void {
		if (this.ranges.length) this.goto((this.current - 1 + this.ranges.length) % this.ranges.length);
	}

	/** Recomputes the matches, keeping the current one when its text is
	 * still there. The first match in or after the current scroll position
	 * is chosen when the query changed. */
	private search(keepIndex = false): void {
		const prev = keepIndex ? this.current : -1;
		this.ranges = this.root ? findRanges(this.root, this.query.trim()) : [];
		this.count = this.ranges.length;
		if (!this.ranges.length) {
			this.current = -1;
			this.paint();
			return;
		}
		let idx = prev >= 0 ? Math.min(prev, this.ranges.length - 1) : -1;
		if (idx < 0) {
			const top = this.root!.getBoundingClientRect().top;
			idx = this.ranges.findIndex((r) => r.getBoundingClientRect().bottom >= top);
			if (idx < 0) idx = 0;
		}
		this.goto(idx);
	}

	/** Opens wells holding the query once the user pauses typing, so a
	 * half-typed word does not expand every well in the conversation. One
	 * character is too little to act on. */
	private scheduleExpand(): void {
		clearTimeout(this.expandTimer);
		const q = this.query.trim();
		if (q.length < 2 || !this.expand) return;
		this.expandTimer = setTimeout(() => this.expand?.(q), 250);
	}

	private goto(idx: number): void {
		this.current = idx;
		this.paint();
		this.reveal(this.ranges[idx]);
	}

	/** Scrolls the transcript so the match sits in the upper third. */
	private reveal(range: Range): void {
		if (!this.root) return;
		const rect = range.getBoundingClientRect();
		const host = this.root.getBoundingClientRect();
		const inView = rect.top >= host.top + 40 && rect.bottom <= host.bottom - 40;
		if (inView) return;
		const top = rect.top - host.top + this.root.scrollTop - host.height / 3;
		this.root.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
	}

	private paint(): void {
		const api = highlights();
		if (api) {
			if (!this.ranges.length) {
				api.registry.delete(HIGHLIGHT_ALL);
				api.registry.delete(HIGHLIGHT_CURRENT);
				return;
			}
			api.registry.set(HIGHLIGHT_ALL, new api.Highlight(...this.ranges));
			api.registry.set(HIGHLIGHT_CURRENT, new api.Highlight(this.ranges[this.current]));
			return;
		}
		const sel = window.getSelection();
		if (!sel) return;
		sel.removeAllRanges();
		if (this.current >= 0) sel.addRange(this.ranges[this.current]);
	}

	/** Re-runs the search when the transcript changes under it: a reply
	 * streaming in, a well opening, a conversation switch. */
	private observe(): void {
		if (this.observer || !this.root || typeof MutationObserver === 'undefined') return;
		this.observer = new MutationObserver(() => {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = setTimeout(() => this.search(true), 150);
		});
		this.observer.observe(this.root, { childList: true, characterData: true, subtree: true });
	}
}

export const find = new FindState();
