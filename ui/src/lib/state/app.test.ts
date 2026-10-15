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
