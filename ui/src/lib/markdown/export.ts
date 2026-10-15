// Serialises a conversation, or one reply, back to markdown with every
// clarification folded in: each well becomes a blockquote placed right after
// the block its quote was highlighted in, and nested wells nest inside it.
// The output is built from the same blocks the transcript renders, so what
// is exported matches what the user saw.

import type { Clarification, Conversation, Turn } from '$lib/api/types';
import { AGENT_NAMES } from '$lib/state/app.svelte';
import { parseBlocks, type Block, type Run } from './blocks';

export function runsToMarkdown(runs: Run[]): string {
	return runs
		.map((r) => {
			let t = r.t;
			if (r.code) t = '`' + t + '`';
			if (r.b) t = `**${t}**`;
			if (r.i) t = `*${t}*`;
			if (r.del) t = `~~${t}~~`;
			if (r.href) t = `[${t}](${r.href})`;
			return t;
		})
		.join('');
}

function indent(depth: number | undefined): string {
	return '  '.repeat(depth ?? 0);
}

/** A fence longer than any backtick run inside the code. */
function fenceFor(code: string): string {
	const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
	return '`'.repeat(longest + 1);
}

export function blockToMarkdown(b: Block): string {
	switch (b.kind) {
		case 'h':
			return `${'#'.repeat(b.level ?? 1)} ${runsToMarkdown(b.runs)}`;
		case 'p':
			return indent(b.depth) + runsToMarkdown(b.runs).replace(/\n/g, '\n' + indent(b.depth));
		case 'li':
			return `${indent(b.depth)}${b.ordered ? `${b.num ?? 1}.` : '-'} ${runsToMarkdown(b.runs)}`;
		case 'code': {
			const fence = fenceFor(b.code ?? '');
			const pad = indent(b.depth);
			return [`${pad}${fence}${b.lang ?? ''}`, ...(b.code ?? '').split('\n').map((l) => pad + l), `${pad}${fence}`].join('\n');
		}
		case 'quote':
			return runsToMarkdown(b.runs)
				.split('\n')
				.map((l) => `> ${l}`)
				.join('\n');
		case 'table': {
			const rows = (b.rows ?? []).map((r) => r.map((c) => runsToMarkdown(c).replace(/\|/g, '\\|')));
			if (!rows.length) return '';
			const width = rows[0].length;
			const line = (cells: string[]) => `| ${cells.concat(Array(Math.max(0, width - cells.length)).fill('')).join(' | ')} |`;
			return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
		}
		case 'hr':
			return '---';
		case 'artifact': {
			const a = b.artifact;
			if (!a) return '';
			const fence = fenceFor(a.content);
			const lang = a.type === 'code' ? a.lang : a.type === 'markdown' ? 'md' : a.type === 'text' ? '' : a.type;
			return [`**${a.title}**`, '', `${fence}${lang}`, a.content, fence].join('\n');
		}
	}
}

/** Joins rendered blocks: adjacent list items share one list, everything
 * else is separated by a blank line. */
export function joinBlocks(parts: { kind: string; md: string }[]): string {
	let out = '';
	let prev: string | null = null;
	for (const p of parts) {
		if (!p.md) continue;
		if (prev !== null) out += prev === 'li' && p.kind === 'li' ? '\n' : '\n\n';
		out += p.md;
		prev = p.kind;
	}
	return out;
}

export function blocksToMarkdown(blocks: Block[]): string {
	return joinBlocks(blocks.map((b) => ({ kind: b.kind, md: blockToMarkdown(b) })));
}

function quoteLines(text: string): string {
	return text
		.split('\n')
		.map((l) => (l ? `> ${l}` : '>'))
		.join('\n');
}

interface Ctx {
	conv: Conversation;
	/** Clarification id → its question/reply turns in order. */
	byClarification: Map<string, Turn[]>;
}

function context(conv: Conversation): Ctx {
	const byClarification = new Map<string, Turn[]>();
	for (const t of conv.turns) {
		if (!t.clarificationId) continue;
		if (!byClarification.has(t.clarificationId)) byClarification.set(t.clarificationId, []);
		byClarification.get(t.clarificationId)!.push(t);
	}
	return { conv, byClarification };
}

/** Blocks of an assistant turn with the wells anchored in them folded in. */
function turnBody(ctx: Ctx, turn: Turn): string {
	const blocks = parseBlocks(turn.text, turn.id);
	const parts: { kind: string; md: string }[] = [];
	for (const b of blocks) {
		parts.push({ kind: b.kind, md: blockToMarkdown(b) });
		for (const cl of ctx.conv.clarifications.filter((c) => c.anchorBlockId === b.id)) {
			parts.push({ kind: 'well', md: wellMarkdown(ctx, cl) });
		}
	}
	return joinBlocks(parts);
}

function wellMarkdown(ctx: Ctx, cl: Clarification): string {
	const number = ctx.conv.clarifications.findIndex((c) => c.id === cl.id) + 1;
	const lines: string[] = [`**Clarification ${number}** · on “${cl.quote.replace(/\s+/g, ' ').trim()}”`];
	for (const t of ctx.byClarification.get(cl.id) ?? []) {
		if (t.role === 'user') lines.push(`**Q:** ${t.text.trim()}`);
		else lines.push(turnBody(ctx, t) || (t.status === 'error' ? `_The agent failed: ${t.error ?? 'no details'}_` : '_No reply._'));
	}
	return quoteLines(lines.join('\n\n'));
}

/** One assistant reply with its clarifications folded in. */
export function exportTurn(conv: Conversation, turn: Turn): string {
	return turnBody(context(conv), turn).trim() + '\n';
}

/** The whole conversation: title, meta line, then every main-column turn. */
export function exportConversation(conv: Conversation): string {
	const ctx = context(conv);
	const agent = AGENT_NAMES[conv.agent] ?? conv.agent;
	const meta = [agent, conv.model, new Date(conv.createdAt).toISOString().slice(0, 10)].filter(Boolean).join(' · ');
	const parts: string[] = [`# ${conv.title}`, `_${meta}_`];
	for (const t of conv.turns) {
		if (t.clarificationId) continue;
		if (t.role === 'user') {
			parts.push('## You', t.text.trim());
			if (t.attachments.length) parts.push(`_Attached: ${t.attachments.map((a) => a.name).join(', ')}_`);
		} else {
			parts.push(`## ${agent}`, turnBody(ctx, t) || '_No reply._');
		}
	}
	return parts.join('\n\n').trim() + '\n';
}

/** File name for an export, from the conversation title. */
export function exportFileName(title: string, suffix = ''): string {
	const base = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
	return `${base || 'conversation'}${suffix}.md`;
}
