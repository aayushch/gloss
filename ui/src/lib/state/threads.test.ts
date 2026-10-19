import { describe, expect, it } from 'vitest';
import type { Conversation, ConversationSummary, Project, Turn } from '$lib/api/types';
import { splitByProject, wellsContaining } from './threads';

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
