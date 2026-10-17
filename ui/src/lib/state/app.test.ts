import { describe, expect, it } from 'vitest';
import { app } from './app.svelte';
import { buildThreads } from './threads';

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('app state against the mock api', () => {
	it('loads, sends a clarification and applies streamed events', async () => {
		await app.init();
		expect(app.agents.length).toBe(5);
		expect(app.active?.id).toBe('conv_cas');
		const reply = app.active!.turns.find((t) => t.role === 'assistant')!;
		const before = app.active!.clarifications.length;

		app.composerFor = { blockId: `${reply.id}:2`, quote: 'useless for synchronization', parentId: null };
		await app.ask('Why useless?');
		expect(app.active!.clarifications.length).toBe(before + 1);
		const cl = app.active!.clarifications[before];
		expect(app.running).toBe(true);

		await settle(1900);
		expect(app.running).toBe(false);
		const threads = buildThreads(app.active!);
		const th = threads.get(cl.id)!;
		expect(th.turns).toHaveLength(1);
		expect(th.turns[0].reply?.status).toBe('done');
		expect(th.turns[0].reply?.text.length).toBeGreaterThan(50);
		expect(app.conversations.find((c) => c.id === 'conv_cas')?.clarificationCount).toBe(before + 1);
	});

	it('keeps the composer open and refuses a clarification while a reply runs', async () => {
		await app.init();
		const reply = app.active!.turns.find((t) => t.role === 'assistant')!;
		const before = app.active!.turns.length;
		app.composerFor = { blockId: `${reply.id}:2`, quote: 'useless for synchronization', parentId: null };
		await app.ask('First question');
		expect(app.running).toBe(true);
		expect(app.active!.turns.length).toBe(before + 2);

		app.composerFor = { blockId: `${reply.id}:1`, quote: 'spinlock', parentId: null };
		await app.ask('Second question while running');
		expect(app.composerFor).not.toBeNull();
		expect(app.active!.turns.length).toBe(before + 2);
		expect(app.notice).toMatch(/wait for the reply/i);
		app.composerFor = null;
		await settle(1900);
		expect(app.running).toBe(false);
	});

	it('stages files named by path and reports the kind from the name', async () => {
		await app.init();
		app.staged = [];
		await app.attachPaths(['/tmp/shot.png', '/tmp/notes.md']);
		expect(app.staged.map((a) => [a.name, a.kind])).toEqual([
			['shot.png', 'image'],
			['notes.md', 'text']
		]);
		expect(app.attachError).toBeNull();
		for (const a of [...app.staged]) await app.unstage(a.id);
	});

	it('binds a draft to a folder and keeps it on the created conversation', async () => {
		app.newChat();
		expect(app.activeProjectDir).toBeNull();
		await app.chooseFolder();
		expect(app.draft?.projectDir).toBe('/Users/me/code/demo-project');
		app.clearFolder();
		expect(app.draft?.projectDir).toBeNull();
		await app.chooseFolder();
		await app.send('What does this project do?');
		expect(app.draft).toBeNull();
		expect(app.active?.projectDir).toBe('/Users/me/code/demo-project');
		expect(app.conversations[0].projectDir).toBe('/Users/me/code/demo-project');
		await settle(100);
		await app.cancel();
		await settle(20);
	});

	it('creates a conversation from a draft on first send and cancels', async () => {
		app.newChat();
		expect(app.draft).not.toBeNull();
		await app.send('Tell me about Rust ownership');
		expect(app.draft).toBeNull();
		expect(app.active?.title).toBe('Tell me about Rust ownership');
		expect(app.running).toBe(true);
		await settle(100);
		await app.cancel();
		await settle(20);
		expect(app.running).toBe(false);
		expect(app.active?.turns[1].status).toBe('cancelled');
	});
});
