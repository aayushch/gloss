// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type {
	Conversation,
	ConversationSummary,
	ExternalSession,
	Project,
	Turn
} from '$lib/api/types';
import {
	agentsIn,
	anchorLabel,
	hostOf,
	pageQuestions,
	pageThreads,
	projectItems,
	splitByProject,
	splitForRail,
	wellsContaining
} from './threads';

function turn(
	id: string,
	text: string,
	clarificationId: string | null,
	role: Turn['role'] = 'assistant'
): Turn {
	return {
		id,
		conversationId: 'c',
		seq: 0,
		role,
		text,
		promptText: null,
		status: 'done',
		clarificationId,
		model: null,
		error: null,
		usage: null,
		createdAt: 0
	} as Turn;
}

const conv = {
	id: 'c',
	turns: [
		turn('t1', 'Main reply about spinlocks', null),
		turn('t2', 'Why does the CPU **reorder** stores?', 'cl1'),
		turn('t3', 'Nested: a fence\nforbids it', 'cl2')
	],
	clarifications: [
		{
			id: 'cl1',
			conversationId: 'c',
			number: 1,
			anchorBlockId: 't1:0',
			quote: 'spinlocks',
			parentId: null,
			open: false,
			createdAt: 0
		},
		{
			id: 'cl2',
			conversationId: 'c',
			number: 2,
			anchorBlockId: 't2:0',
			quote: 'reorder',
			parentId: 'cl1',
			open: false,
			createdAt: 0
		}
	]
} as unknown as Conversation;

describe('wellsContaining', () => {
	it('matches well turns case-insensitively and ignores main-column turns', () => {
		expect(wellsContaining(conv, 'REORDER')).toEqual(['cl2', 'cl1']);
		expect(wellsContaining(conv, 'Main reply')).toEqual([]);
	});
	it('matches the quoted text and collapses whitespace', () => {
		expect(wellsContaining(conv, 'spinlocks')).toEqual(['cl1']);
		expect(wellsContaining(conv, 'fence forbids')).toEqual(['cl2']);
	});
	it('returns nothing for an empty query', () => {
		expect(wellsContaining(conv, '  ')).toEqual([]);
	});
});

describe('splitByProject', () => {
	const conv = (id: string, projectDir: string | null) =>
		({ id, projectDir }) as ConversationSummary;
	const project = (path: string) =>
		({ path, name: path, createdAt: 0, lastActiveAt: 0 }) as Project;

	it('groups by project and keeps chats of removed projects with the rest', () => {
		const { byProject, rest } = splitByProject(
			[conv('a', '/p/one'), conv('b', null), conv('c', '/p/gone'), conv('d', '/p/one')],
			[project('/p/one'), project('/p/empty')]
		);
		expect(byProject.get('/p/one')!.map((c) => c.id)).toEqual(['a', 'd']);
		expect(byProject.get('/p/empty')).toEqual([]);
		expect(rest.map((c) => c.id)).toEqual(['b', 'c']);
	});
});

describe('splitForRail', () => {
	const conv = (id: string, projectDir: string | null, pageKey: string | null = null) =>
		({ id, projectDir, pageKey }) as ConversationSummary;
	const project = (path: string) =>
		({ path, name: path, createdAt: 0, lastActiveAt: 0 }) as Project;

	it('keeps page conversations out of the project and date lists', () => {
		const { byProject, pages, rest } = splitForRail(
			[
				conv('a', '/p/one'),
				conv('w', null, 'https://example.com/x'),
				conv('b', null),
				conv('w2', '/p/one', 'https://example.com/y')
			],
			[project('/p/one')]
		);
		expect(byProject.get('/p/one')!.map((c) => c.id)).toEqual(['a']);
		expect(pages.map((c) => c.id)).toEqual(['w', 'w2']);
		expect(rest.map((c) => c.id)).toEqual(['b']);
		expect(
			splitByProject([conv('w', null, 'https://example.com/x'), conv('b', null)], []).rest.map(
				(c) => c.id
			)
		).toEqual(['b']);
	});
});

describe('page threads', () => {
	const web = { quote: { exact: 'q', prefix: '', suffix: '' }, position: null, container: null };
	const pageConv = {
		id: 'p',
		turns: [
			turn('u1', 'What is this about?', null, 'user'),
			turn('a1', 'Store buffers.', null),
			turn('u2', 'Why?', 'w1', 'user'),
			turn('a2', 'Because.', 'w1'),
			turn('u3', 'And nested?', 'w2', 'user'),
			turn('u4', 'Old style?', 'cl9', 'user')
		],
		clarifications: [
			{
				id: 'w1',
				anchorBlockId: '',
				quote: 'first passage',
				parentId: null,
				webAnchor: web,
				anchorState: 'anchored'
			},
			{
				id: 'w2',
				anchorBlockId: '',
				quote: 'inside the reply',
				parentId: 'w1',
				webAnchor: web,
				anchorState: 'orphan'
			},
			{
				id: 'cl9',
				anchorBlockId: 'a1:0',
				quote: 'buffers',
				parentId: null,
				webAnchor: null,
				anchorState: null
			}
		]
	} as unknown as Conversation;

	it('lists only the asks with a web anchor, with their turns', () => {
		const threads = pageThreads(pageConv);
		expect(threads.map((t) => t.clarification.id)).toEqual(['w1', 'w2']);
		expect(threads[0].turns).toHaveLength(1);
		expect(threads[0].turns[0].reply?.id).toBe('a2');
	});

	it('page questions are the turns outside any ask', () => {
		expect(pageQuestions(pageConv).map((t) => t.id)).toEqual(['u1', 'a1']);
	});

	it('labels anchor states and reads hosts', () => {
		expect(anchorLabel('anchored')).toBe('');
		expect(anchorLabel('fuzzy')).toBe('approximate match');
		expect(anchorLabel('orphan')).toBe('not on the page any more');
		expect(hostOf('https://www.example.com/a/b?x=1')).toBe('example.com');
		expect(hostOf('not a url')).toBe('not a url');
	});
});

describe('projectItems', () => {
	const chat = (id: string, agent: string, updatedAt: number, pinned = false) =>
		({ id, agent, updatedAt, pinned }) as ConversationSummary;
	const session = (id: string, agent: string, updatedAt: number) =>
		({ id, agent, updatedAt }) as ExternalSession;
	const key = (i: ReturnType<typeof projectItems>[number]) =>
		i.kind === 'chat' ? i.chat.id : i.session.id;
	const chats = [chat('a', 'claude', 10), chat('b', 'pi', 50, true), chat('c', 'claude', 30)];
	const sessions = [session('s1', 'codex', 40), session('s2', 'claude', 20)];

	it('puts pinned chats first, then mixes chats and sessions by recency', () => {
		expect(projectItems(chats, sessions, null).map(key)).toEqual(['b', 's1', 'c', 's2', 'a']);
	});

	it('filters by agent and lists the agents present', () => {
		expect(projectItems(chats, sessions, 'claude').map(key)).toEqual(['c', 's2', 'a']);
		expect(agentsIn(chats, sessions)).toEqual(['claude', 'codex', 'pi']);
	});
});
