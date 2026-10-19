import { describe, expect, it } from 'vitest';
import type { Conversation, ConversationSummary, ExternalSession, Project, Turn } from '$lib/api/types';
import { agentsIn, projectItems, splitByProject, wellsContaining } from './threads';

function turn(id: string, text: string, clarificationId: string | null): Turn {
	return { id, conversationId: 'c', seq: 0, role: 'assistant', text, promptText: null, status: 'done', clarificationId, model: null, error: null, usage: null, createdAt: 0 } as Turn;
}

const conv = {
	id: 'c',
	turns: [
		turn('t1', 'Main reply about spinlocks', null),
		turn('t2', 'Why does the CPU **reorder** stores?', 'cl1'),
		turn('t3', 'Nested: a fence\nforbids it', 'cl2')
	],
	clarifications: [
		{ id: 'cl1', conversationId: 'c', number: 1, anchorBlockId: 't1:0', quote: 'spinlocks', parentId: null, open: false, createdAt: 0 },
		{ id: 'cl2', conversationId: 'c', number: 2, anchorBlockId: 't2:0', quote: 'reorder', parentId: 'cl1', open: false, createdAt: 0 }
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
	const conv = (id: string, projectDir: string | null) => ({ id, projectDir }) as ConversationSummary;
	const project = (path: string) => ({ path, name: path, createdAt: 0, lastActiveAt: 0 }) as Project;

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

describe('projectItems', () => {
	const chat = (id: string, agent: string, updatedAt: number, pinned = false) => ({ id, agent, updatedAt, pinned }) as ConversationSummary;
	const session = (id: string, agent: string, updatedAt: number) => ({ id, agent, updatedAt }) as ExternalSession;
	const key = (i: ReturnType<typeof projectItems>[number]) => (i.kind === 'chat' ? i.chat.id : i.session.id);
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
