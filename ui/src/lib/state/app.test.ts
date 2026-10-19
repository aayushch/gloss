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

	it('adds a project from the draft picker and keeps it on the created conversation', async () => {
		app.newChat();
		expect(app.activeProjectDir).toBeNull();
		await app.addProjectToDraft();
		expect(app.draft?.projectDir).toBe('/Users/me/code/demo-project');
		expect(app.projects.map((p) => p.path)).toContain('/Users/me/code/demo-project');
		expect(app.expanded['/Users/me/code/demo-project']).toBe(true);
		app.chooseProject(null);
		expect(app.draft?.projectDir).toBeNull();
		app.chooseProject('/Users/me/code/demo-project');
		await app.send('What does this project do?');
		expect(app.draft).toBeNull();
		expect(app.active?.projectDir).toBe('/Users/me/code/demo-project');
		expect(app.conversations[0].projectDir).toBe('/Users/me/code/demo-project');
		await settle(100);
		await app.cancel();
		await settle(20);
	});

	it('starts a chat inside a project or outside any project', async () => {
		app.newChat('/Users/me/code/demo-project');
		expect(app.draft?.projectDir).toBe('/Users/me/code/demo-project');
		app.newChat();
		expect(app.draft?.projectDir).toBeNull();
		app.toggleProject('/Users/me/code/demo-project', true);
		await settle(10);
		expect(app.outside['/Users/me/code/demo-project'].map((x) => x.agent)).toEqual(['claude', 'codex', 'pi']);
		app.setAgentFilter('/Users/me/code/demo-project', 'codex');
		expect(app.agentFilter['/Users/me/code/demo-project']).toBe('codex');
		app.setAgentFilter('/Users/me/code/demo-project', 'codex');
		expect(app.agentFilter['/Users/me/code/demo-project']).toBeNull();
		await app.removeProject('/Users/me/code/demo-project');
		expect(app.projects.find((p) => p.path === '/Users/me/code/demo-project')).toBeUndefined();
	});

	it('shows the agent\'s question as a request and resumes once answered', async () => {
		app.newChat();
		await app.send('[ask] Which style?');
		await settle(150);
		const turn = app.active!.turns.find((t) => t.role === 'assistant')!;
		expect(app.requests[turn.id]?.kind).toBe('question');
		await app.answer(turn.id, { kind: 'question', answers: { 'Which style do you prefer?': 'Tabs' } });
		await settle(50);
		expect(app.requests[turn.id]).toBeUndefined();
		expect(app.running).toBe(true);
		await settle(1900);
		expect(app.running).toBe(false);
		// The done event replaces the turn row, so look it up again.
		expect(app.active!.turns.find((t) => t.id === turn.id)?.status).toBe('done');
	});

	it('a permission answer can switch the mode of a project-bound conversation', async () => {
		app.newChat();
		await app.addProjectToDraft();
		await app.setMode('manual');
		expect(app.draft?.mode).toBe('manual');
		await app.send('[write] Create NOTES.md');
		expect(app.active?.mode).toBe('manual');
		await settle(150);
		const turn = app.active!.turns.find((t) => t.role === 'assistant')!;
		expect(app.requests[turn.id]?.kind).toBe('permission');
		await app.answer(turn.id, { kind: 'permission', allow: true, message: null, setMode: 'acceptEdits' });
		await settle(50);
		expect(app.active?.mode).toBe('acceptEdits');
		await settle(1900);
		await app.setMode(null);
		expect(app.active?.mode).toBeNull();
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
