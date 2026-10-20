import { describe, expect, it } from 'vitest';
import type { Conversation, Turn } from '$lib/api/types';
import { blockToMarkdown, blocksToMarkdown, exportConversation, exportFileName, exportPage, exportTurn } from './export';
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
	pageKey: null,
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
		{ id: 'cl1', conversationId: 'c', number: 1, anchorBlockId: 't2:0', quote: 'bold', parentId: null, open: true, createdAt: 0, webAnchor: null, anchorState: null },
		{ id: 'cl2', conversationId: 'c', number: 2, anchorBlockId: 't4:1', quote: 'Second', parentId: 'cl1', open: true, createdAt: 0, webAnchor: null, anchorState: null }
	]
};

const pageConv: Conversation = {
	...conv,
	id: 'p',
	title: 'Store buffers',
	pageKey: 'https://example.com/post',
	turns: [
		turn('p1', 'user', 'What is this page about?'),
		turn('p2', 'assistant', 'Store buffers and **ordering**.'),
		turn('p3', 'user', 'Why no wait?', 'w1'),
		turn('p4', 'assistant', 'Because the buffer absorbs it.', 'w1'),
		turn('p5', 'user', 'On ARM too?', 'w2'),
		turn('p6', 'assistant', 'No.', 'w2')
	],
	clarifications: [
		{ id: 'w1', conversationId: 'p', number: 1, anchorBlockId: '', quote: 'a store retires   into the buffer', parentId: null, open: true, createdAt: 0, webAnchor: { quote: { exact: 'a store retires into the buffer', prefix: '', suffix: '' }, position: null, container: null }, anchorState: 'anchored' },
		{ id: 'w2', conversationId: 'p', number: 2, anchorBlockId: '', quote: 'drains in order', parentId: null, open: true, createdAt: 0, webAnchor: { quote: { exact: 'drains in order', prefix: '', suffix: '' }, position: null, container: null }, anchorState: 'orphan' }
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

	it('writes page notes: title, URL, page questions first, then each ask as a quote with its Q/A pairs', () => {
		const page = { urlKey: 'https://example.com/post', url: 'https://example.com/post?ref=x', title: 'Understanding store buffers', faviconUrl: null, conversationId: 'p', askCount: 2, orphanCount: 1, firstSeen: 0, lastSeen: 0, updatedAt: 0 };
		expect(exportPage(pageConv, page)).toBe(
			[
				'# Understanding store buffers',
				'',
				'<https://example.com/post?ref=x>',
				'',
				'**Q:** What is this page about?',
				'',
				'Store buffers and **ordering**.',
				'',
				'> a store retires into the buffer',
				'',
				'**Q:** Why no wait?',
				'',
				'Because the buffer absorbs it.',
				'',
				'> drains in order',
				'',
				'**Q:** On ARM too?',
				'',
				'No.',
				''
			].join('\n')
		);
	});

	it('falls back to the conversation title and pageKey without a page record', () => {
		expect(exportPage(pageConv, null).startsWith('# Store buffers\n\n<https://example.com/post>\n\n')).toBe(true);
	});

	it('derives a safe file name', () => {
		expect(exportFileName('A test: chat', '-reply')).toBe('a-test-chat-reply.md');
		expect(exportFileName('???')).toBe('conversation.md');
	});
});
