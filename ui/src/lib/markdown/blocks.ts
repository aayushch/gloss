// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

// Turns an assistant turn's markdown into a flat list of blocks. Each block
// carries inline runs (text with formatting flags) and its plain text, which
// is what clarification quotes are matched against. Block i of turn T has the
// id `T:i`, so an anchor can find its block again after a re-render.

import { lexer, type Token, type Tokens } from 'marked';
import { extractArtifacts, placeholderIndex, type Artifact } from './artifacts';

export interface Run {
	t: string;
	b?: boolean;
	i?: boolean;
	code?: boolean;
	del?: boolean;
	href?: string;
}

export type BlockKind = 'p' | 'h' | 'li' | 'code' | 'quote' | 'table' | 'hr' | 'artifact';

export interface Block {
	id: string;
	kind: BlockKind;
	/** Inline content. Empty for code, table and hr. */
	runs: Run[];
	/** Plain text: concatenated runs, or the raw code for a code block. */
	text: string;
	/** Headings: 1..6. */
	level?: number;
	/** List items: nesting depth starting at 0. */
	depth?: number;
	ordered?: boolean;
	/** Ordered list items: the number shown. */
	num?: number;
	/** Code blocks. */
	lang?: string;
	code?: string;
	/** Tables: header row followed by body rows, each cell as runs. */
	rows?: Run[][][];
	/** Artifact blocks: the artifact the agent wrote at this point. */
	artifact?: Artifact;
}

/** Flattens marked inline tokens into runs, carrying formatting flags down. */
function inlineRuns(tokens: Token[] | undefined, flags: Omit<Run, 't'> = {}): Run[] {
	const out: Run[] = [];
	if (!tokens) return out;
	for (const tok of tokens) {
		switch (tok.type) {
			case 'text': {
				const t = tok as Tokens.Text;
				if (t.tokens && t.tokens.length) out.push(...inlineRuns(t.tokens, flags));
				else out.push({ t: decode(t.text), ...flags });
				break;
			}
			case 'escape':
				out.push({ t: (tok as Tokens.Escape).text, ...flags });
				break;
			case 'strong':
				out.push(...inlineRuns((tok as Tokens.Strong).tokens, { ...flags, b: true }));
				break;
			case 'em':
				out.push(...inlineRuns((tok as Tokens.Em).tokens, { ...flags, i: true }));
				break;
			case 'del':
				out.push(...inlineRuns((tok as Tokens.Del).tokens, { ...flags, del: true }));
				break;
			case 'codespan':
				out.push({ t: decode((tok as Tokens.Codespan).text), ...flags, code: true });
				break;
			case 'link': {
				const l = tok as Tokens.Link;
				out.push(...inlineRuns(l.tokens, { ...flags, href: l.href }));
				break;
			}
			case 'image':
				out.push({ t: (tok as Tokens.Image).text || '[image]', ...flags, i: true });
				break;
			case 'br':
				out.push({ t: '\n', ...flags });
				break;
			case 'html':
				out.push({ t: stripTags((tok as Tokens.HTML).text), ...flags });
				break;
			default:
				if ('tokens' in tok && Array.isArray((tok as { tokens?: Token[] }).tokens)) {
					out.push(...inlineRuns((tok as { tokens: Token[] }).tokens, flags));
				} else if ('text' in tok && typeof (tok as { text?: string }).text === 'string') {
					out.push({ t: (tok as { text: string }).text, ...flags });
				}
		}
	}
	return mergeRuns(out);
}

/** Joins adjacent runs that share the same formatting so marks split less. */
function mergeRuns(runs: Run[]): Run[] {
	const out: Run[] = [];
	for (const r of runs) {
		if (!r.t) continue;
		const last = out[out.length - 1];
		if (last && sameFlags(last, r)) last.t += r.t;
		else out.push({ ...r });
	}
	return out;
}

function sameFlags(a: Run, b: Run): boolean {
	return (
		!!a.b === !!b.b &&
		!!a.i === !!b.i &&
		!!a.code === !!b.code &&
		!!a.del === !!b.del &&
		a.href === b.href
	);
}

const ENTITIES: Record<string, string> = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#39;': "'",
	'&nbsp;': ' '
};

function decode(s: string): string {
	return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

function stripTags(s: string): string {
	return s.replace(/<[^>]*>/g, '');
}

export function parseBlocks(markdown: string, turnId: string): Block[] {
	const blocks: Block[] = [];
	const { text, artifacts } = extractArtifacts(markdown ?? '');
	// A paragraph holding an artifact placeholder becomes the artifact's block.
	const push = (b: Omit<Block, 'id'>) => {
		const idx = b.kind === 'p' ? placeholderIndex(b.text) : null;
		const block =
			idx !== null && artifacts[idx]
				? { kind: 'artifact' as const, runs: [], text: '', artifact: artifacts[idx] }
				: b;
		blocks.push({ ...block, id: `${turnId}:${blocks.length}` });
	};
	let tokens: Token[];
	try {
		tokens = lexer(text);
	} catch {
		push({ kind: 'p', runs: [{ t: text }], text });
		return blocks;
	}
	walk(tokens, push, 0);
	return blocks;
}

type Push = (b: Omit<Block, 'id'>) => void;

function walk(tokens: Token[], push: Push, depth: number): void {
	for (const tok of tokens) {
		switch (tok.type) {
			case 'space':
				break;
			case 'heading': {
				const h = tok as Tokens.Heading;
				const runs = inlineRuns(h.tokens);
				push({ kind: 'h', level: h.depth, runs, text: textOf(runs) });
				break;
			}
			case 'paragraph': {
				const runs = inlineRuns((tok as Tokens.Paragraph).tokens);
				push({ kind: 'p', runs, text: textOf(runs), depth: depth || undefined });
				break;
			}
			case 'text': {
				// Loose list items and blockquotes wrap text in a bare text token.
				const t = tok as Tokens.Text;
				const runs = inlineRuns(t.tokens ?? [{ type: 'text', raw: t.raw, text: t.text } as Token]);
				push({ kind: 'p', runs, text: textOf(runs), depth: depth || undefined });
				break;
			}
			case 'code': {
				const c = tok as Tokens.Code;
				push({
					kind: 'code',
					lang: (c.lang ?? '').trim().split(/\s+/)[0] || '',
					code: c.text,
					runs: [],
					text: c.text,
					depth: depth || undefined
				});
				break;
			}
			case 'blockquote': {
				const q = tok as Tokens.Blockquote;
				// Each paragraph inside the quote becomes its own quote block so
				// that anchoring stays within one paragraph.
				for (const inner of q.tokens) {
					if (inner.type === 'paragraph' || inner.type === 'text') {
						const runs = inlineRuns((inner as Tokens.Paragraph).tokens);
						push({ kind: 'quote', runs, text: textOf(runs), depth: depth || undefined });
					} else {
						walk([inner], push, depth);
					}
				}
				break;
			}
			case 'list':
				listBlocks(tok as Tokens.List, push, depth);
				break;
			case 'table': {
				const t = tok as Tokens.Table;
				const rows: Run[][][] = [
					t.header.map((c) => inlineRuns(c.tokens)),
					...t.rows.map((r) => r.map((c) => inlineRuns(c.tokens)))
				];
				const text = rows.map((r) => r.map((c) => textOf(c)).join(' | ')).join('\n');
				push({ kind: 'table', rows, runs: [], text });
				break;
			}
			case 'hr':
				push({ kind: 'hr', runs: [], text: '' });
				break;
			case 'html': {
				const text = stripTags((tok as Tokens.HTML).text).trim();
				if (text) push({ kind: 'p', runs: [{ t: text }], text });
				break;
			}
			default: {
				const any = tok as { tokens?: Token[]; text?: string; raw?: string };
				if (any.tokens) walk(any.tokens, push, depth);
				else if (any.raw?.trim())
					push({ kind: 'p', runs: [{ t: any.raw.trim() }], text: any.raw.trim() });
			}
		}
	}
}

function listBlocks(list: Tokens.List, push: Push, depth: number): void {
	const start = typeof list.start === 'number' ? list.start : 1;
	list.items.forEach((item, idx) => {
		// The first inline chunk is the item's own line; anything after it
		// (nested lists, paragraphs, code) follows as separate blocks.
		const own: Token[] = [];
		const rest: Token[] = [];
		let seenBlock = false;
		for (const t of item.tokens) {
			if (!seenBlock && (t.type === 'text' || t.type === 'paragraph')) {
				own.push(...(((t as Tokens.Text).tokens ?? []) as Token[]));
				seenBlock = true;
			} else if (t.type === 'space') {
				continue;
			} else {
				rest.push(t);
			}
		}
		const runs = inlineRuns(own);
		const prefix = item.task ? (item.checked ? '[x] ' : '[ ] ') : '';
		if (prefix) runs.unshift({ t: prefix });
		push({
			kind: 'li',
			runs,
			text: textOf(runs),
			depth,
			ordered: list.ordered,
			num: list.ordered ? start + idx : undefined
		});
		for (const t of rest) {
			if (t.type === 'list') listBlocks(t as Tokens.List, push, depth + 1);
			else walk([t], push, depth + 1);
		}
	});
}

function textOf(runs: Run[]): string {
	return runs.map((r) => r.t).join('');
}
