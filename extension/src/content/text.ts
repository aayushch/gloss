// A normalised view of a page's text with a map back to the DOM.
//
// The index walks the text nodes under a root in document order, skips what
// a reader never sees (scripts, styles, hidden elements, the Gloss host) and
// collapses every run of whitespace to one space. Block boundaries and <br>
// become a single space too, so "<p>a</p><p>b</p>" reads "a b". Each
// character of `text` remembers which text node and offset it came from,
// which lets offsets become DOM ranges and ranges become offsets.

/** Tag name of the element that hosts the extension's shadow DOM. */
export const HOST_TAG = 'gloss-ask-host';

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'canvas', 'head', HOST_TAG]);

const BLOCK_TAGS = new Set([
	'address', 'article', 'aside', 'blockquote', 'body', 'br', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
	'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
	'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
	'tr', 'ul',
]);

/** Elements whose text the index leaves out. */
export function isSkipped(el: Element): boolean {
	const tag = el.localName;
	if (SKIP_TAGS.has(tag)) return true;
	if (el.hasAttribute('hidden')) return true;
	if (el.getAttribute('aria-hidden') === 'true') return true;
	const style = (el as HTMLElement).style;
	if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
	return false;
}

function isWhitespace(ch: string): boolean {
	return /\s/.test(ch);
}

export interface Offsets {
	start: number;
	end: number;
}

export class TextIndex {
	/** The normalised text. */
	readonly text: string;
	private readonly nodes: Text[] = [];
	/** For each character of `text`: the index into `nodes`, or -1 for a space that stands for a block boundary. */
	private readonly charNode: Int32Array;
	/** For each character of `text`: its offset inside its text node. */
	private readonly charOffset: Int32Array;
	/** For each text node: the first and last character index it contributed, or -1 when it contributed none. */
	private readonly nodeFirst: number[] = [];
	private readonly nodeLast: number[] = [];
	private readonly doc: Document;

	constructor(root: Node) {
		this.doc = root.ownerDocument ?? (root as Document);
		const chars: string[] = [];
		let nodeIdx: number[] = [];
		let offs: number[] = [];
		let lastWasSpace = true;

		const push = (ch: string, node: number, off: number) => {
			chars.push(ch);
			nodeIdx.push(node);
			offs.push(off);
		};
		const boundary = () => {
			if (!lastWasSpace) {
				push(' ', -1, 0);
				lastWasSpace = true;
			}
		};

		const visit = (node: Node) => {
			if (node.nodeType === Node.TEXT_NODE) {
				const data = (node as Text).data;
				if (!data) return;
				const n = this.nodes.length;
				this.nodes.push(node as Text);
				let first = -1;
				let last = -1;
				for (let i = 0; i < data.length; i++) {
					const ch = data[i];
					if (isWhitespace(ch)) {
						if (lastWasSpace) continue;
						push(' ', n, i);
						lastWasSpace = true;
					} else {
						push(ch, n, i);
						lastWasSpace = false;
					}
					if (first < 0) first = chars.length - 1;
					last = chars.length - 1;
				}
				this.nodeFirst.push(first);
				this.nodeLast.push(last);
				return;
			}
			if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
			if (node.nodeType === Node.ELEMENT_NODE) {
				const el = node as Element;
				if (isSkipped(el)) return;
				const block = BLOCK_TAGS.has(el.localName);
				if (block) boundary();
				for (let c = el.firstChild; c; c = c.nextSibling) visit(c);
				if (block) boundary();
				return;
			}
			for (let c = node.firstChild; c; c = c.nextSibling) visit(c);
		};
		visit(root);
		// A boundary space at the very end stands for nothing that follows.
		if (chars.length && nodeIdx[chars.length - 1] < 0) {
			chars.pop();
			nodeIdx.pop();
			offs.pop();
		}

		this.text = chars.join('');
		this.charNode = Int32Array.from(nodeIdx);
		this.charOffset = Int32Array.from(offs);
		nodeIdx = [];
		offs = [];
	}

	/** Builds the index of a whole document's body. */
	static ofDocument(doc: Document): TextIndex {
		return new TextIndex(doc.body ?? doc.documentElement);
	}

	/**
	 * The DOM range covering `text.slice(start, end)`. Boundary spaces at
	 * the edges are skipped, so the range starts and ends on page text.
	 */
	toRange(start: number, end: number): Range {
		const range = this.doc.createRange();
		let s = Math.max(0, start);
		let e = Math.min(end, this.text.length) - 1;
		while (s <= e && this.charNode[s] < 0) s++;
		while (e >= s && this.charNode[e] < 0) e--;
		if (s > e) {
			// Nothing but boundary spaces: a collapsed range at the start of the text.
			if (this.nodes.length) range.setStart(this.nodes[0], 0);
			range.collapse(true);
			return range;
		}
		range.setStart(this.nodes[this.charNode[s]], this.charOffset[s]);
		range.setEnd(this.nodes[this.charNode[e]], this.charOffset[e] + 1);
		return range;
	}

	/** Offsets into `text` for a DOM range, or null when the range holds no indexed text. */
	fromRange(range: Range): Offsets | null {
		if (!this.nodes.length) return null;
		const start = this.offsetAfter(range.startContainer, range.startOffset);
		const end = this.offsetBefore(range.endContainer, range.endOffset);
		if (start === null || end === null || start >= end) return null;
		return { start, end };
	}

	/** Offsets of an element's whole text content, or null when it has none. */
	ofElement(el: Element): Offsets | null {
		const range = this.doc.createRange();
		range.selectNodeContents(el);
		return this.fromRange(range);
	}

	/** -1, 0 or 1: whether the point (container, offset) lies before, at or after (node, nodeOffset). */
	private compare(container: Node, offset: number, node: Text, nodeOffset: number): number {
		const probe = this.doc.createRange();
		probe.setStart(node, nodeOffset);
		probe.collapse(true);
		try {
			return probe.comparePoint(container, offset);
		} catch {
			return 1;
		}
	}

	/** The index of the first character at or after a boundary point. */
	private offsetAfter(container: Node, offset: number): number | null {
		// First node whose end lies after the point.
		let lo = 0;
		let hi = this.nodes.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			const n = this.nodes[mid];
			if (this.compare(container, offset, n, n.data.length) < 0) hi = mid;
			else lo = mid + 1;
		}
		for (let i = lo; i < this.nodes.length; i++) {
			const n = this.nodes[i];
			const want = n === container ? offset : 0;
			const first = this.nodeFirst[i];
			if (first < 0) continue;
			const last = this.nodeLast[i];
			// Characters of one node sit in increasing offset order.
			let a = first;
			let b = last + 1;
			while (a < b) {
				const mid = (a + b) >> 1;
				if (this.charOffset[mid] >= want && this.charNode[mid] === i) b = mid;
				else a = mid + 1;
			}
			for (let k = a; k <= last; k++) {
				if (this.charNode[k] === i && this.charOffset[k] >= want) return k;
			}
		}
		return null;
	}

	/** One past the index of the last character before a boundary point. */
	private offsetBefore(container: Node, offset: number): number | null {
		// Last node whose start lies before the point.
		let lo = 0;
		let hi = this.nodes.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.compare(container, offset, this.nodes[mid], 0) > 0) lo = mid + 1;
			else hi = mid;
		}
		for (let i = lo - 1; i >= 0; i--) {
			const n = this.nodes[i];
			const want = n === container ? offset : n.data.length;
			const first = this.nodeFirst[i];
			if (first < 0) continue;
			for (let k = this.nodeLast[i]; k >= first; k--) {
				if (this.charNode[k] === i && this.charOffset[k] < want) return k + 1;
			}
		}
		return null;
	}
}

/** Collapses whitespace runs to one space and trims, the way the index normalises page text. */
export function normalise(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}
