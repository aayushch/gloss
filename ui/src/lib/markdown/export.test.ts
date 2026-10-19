import { describe, expect, it } from 'vitest';
import type { Conversation, Turn } from '$lib/api/types';
import { blockToMarkdown, blocksToMarkdown, exportConversation, exportFileName, exportTurn } from './export';
import { parseBlocks } from './blocks';

function turn(id: string, role: Turn['role'], text: string, clarificationId: string | null = null): Turn {
	return { id, conversationId: 'c', seq: 0, role, text, promptText: null, status: 'done', clarificationId, model: null, error: null, usage: null, createdAt: 0, completedAt: 0, attachments: [] };
}

const reply = turn('t2', 'assistant', 'First paragraph with **bold** and `code`.\n\n- item one\n- item two\n\n```js\nlet x = 1;\n```\n\nLast line.');

const conv: Conversation = {
	id: 'c',
	title: 'A test: chat',
	agent: 'claude',
	model: 'haiku',
	webSearch: false,
	pinned: false,
	tags: [],
	clarificationCount: 2,
	projectDir: null,
	mode: null,
	createdAt: Date.UTC(2026, 9, 14),
	updatedAt: 0,
	agentSessionId: null,
	continuedFrom: null,
	running: false,
	pendingRequest: null,
	turns: [
		turn('t1', 'user', 'Question?'),
		reply,
		turn('t3', 'user', 'Why bold?', 'cl1'),
		turn('t4', 'assistant', 'Because *emphasis*.\n\nSecond.', 'cl1'),
		turn('t5', 'user', 'Nested?', 'cl2'),
		turn('t6', 'assistant', 'Yes.', 'cl2')
	],
	clarifications: [
		{ id: 'cl1', conversationId: 'c', number: 1, anchorBlockId: 't2:0', quote: 'bold', parentId: null, open: true, createdAt: 0 },
		{ id: 'cl2', conversationId: 'c', number: 2, anchorBlockId: 't4:1', quote: 'Second', parentId: 'cl1', open: true, createdAt: 0 }
	]
};

describe('blockToMarkdown', () => {
	it('round-trips common blocks', () => {
		const md = '# Title\n\nPara *i* **b** ~~d~~ [l](http://x)\n\n1. one\n2. two\n\n> quoted\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---';
		const out = blocksToMarkdown(parseBlocks(md, 't'));
		expect(out).toBe(md);
	});

	it('picks a fence longer than backticks inside code', () => {
		const [b] = parseBlocks('````md\n```js\n````', 't');
		expect(blockToMarkdown(b)).toBe('````md\n```js\n````');
	});
});

describe('exportTurn', () => {
	it('folds wells in after their anchor block, nesting as blockquotes', () => {
		const out = exportTurn(conv, reply);
		expect(out).toBe(
			[
				'First paragraph with **bold** and `code`.',
				'',
				'> **Clarification 1** · on “bold”',
				'>',
				'> **Q:** Why bold?',
				'>',
				'> Because *emphasis*.',
				'>',
				'> Second.',
				'>',
				'> > **Clarification 2** · on “Second”',
				'> >',
				'> > **Q:** Nested?',
				'> >',
				'> > Yes.',
				'',
				'- item one',
				'- item two',
				'',
				'```js',
				'let x = 1;',
				'```',
				'',
				'Last line.',
				''
			].join('\n')
		);
	});
});

describe('exportConversation', () => {
	it('writes a title, meta line and main turns only', () => {
		const out = exportConversation(conv);
		expect(out.startsWith('# A test: chat\n\n_Claude Code · haiku · 2026-10-14_\n\n## You\n\nQuestion?\n\n## Claude Code\n\n')).toBe(true);
		expect(out).not.toContain('## You\n\nWhy bold?');
		expect(out).toContain('> **Q:** Why bold?');
	});

	it('derives a safe file name', () => {
		expect(exportFileName('A test: chat', '-reply')).toBe('a-test-chat-reply.md');
		expect(exportFileName('???')).toBe('conversation.md');
	});
});
