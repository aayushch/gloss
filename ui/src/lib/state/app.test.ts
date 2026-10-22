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

	it('renames the open conversation in the list and the header, ignoring blank or unchanged titles', async () => {
		await app.init();
		const id = app.active!.id;
		const before = app.active!.title;
		await app.rename(id, '   ');
		expect(app.active!.title).toBe(before);
		await app.rename(id, '  Spinlocks, revisited  ');
		expect(app.active!.title).toBe('Spinlocks, revisited');
		expect(app.conversations.find((c) => c.id === id)?.title).toBe('Spinlocks, revisited');
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

	it('opens an outside session read-only and continues it by sending', async () => {
		const project = '/Users/me/code/demo-project';
		app.newChat(project);
		app.toggleProject(project, true);
		await settle(10);
		const session = app.outside[project].find((x) => x.agent === 'claude')!;
		await app.openSession(project, session);
		expect(app.active).toBeNull();
		expect(app.activeAgentId).toBe('claude');
		expect(app.activeProjectDir).toBe(project);
		expect(app.viewing?.turns?.length).toBe(2);

		await app.send('Now add a test for it');
		expect(app.viewing).toBeNull();
		expect(app.active?.agentSessionId).toBe(session.id);
		expect(app.active?.continuedFrom).toBe(session.file);
		expect(app.active?.title).toBe(session.title);
		expect(app.earlier.length).toBe(2);
		expect(app.outside[project].some((x) => x.id === session.id)).toBe(false);
		await settle(100);
		await app.cancel();
		await settle(20);

		// Reopening the conversation loads the earlier turns again.
		const id = app.active!.id;
		app.newChat();
		expect(app.earlier).toEqual([]);
		await app.open(id);
		expect(app.earlier.length).toBe(2);
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

	it('lists pages, opens one at an ask, removes the ask and deletes the page', async () => {
		await app.init();
		await settle(10);
		const page = app.pages.find((p) => p.urlKey === 'https://example.com/cpu/store-buffers')!;
		expect(page.askCount).toBe(2);
		expect(page.orphanCount).toBe(1);
		expect(app.conversations.some((c) => c.pageKey === page.urlKey)).toBe(true);

		await app.openPage(page.urlKey, 'cl_web2');
		expect(app.active?.id).toBe(page.conversationId);
		expect(app.active?.pageKey).toBe(page.urlKey);
		expect(app.activePage?.title).toBe('Understanding store buffers');
		expect(app.jumpTarget).toBe('well-cl_web2');
		expect(app.active?.clarifications.find((c) => c.id === 'cl_web2')?.open).toBe(true);
		expect(app.pagesExpanded[page.urlKey]).toBe(true);
		await settle(10);
		expect(app.pageAsks[page.urlKey]?.map((c) => c.id)).toEqual(['cl_web1', 'cl_web2']);

		await app.removeAsk('cl_web2');
		await settle(10);
		expect(app.active?.clarifications.map((c) => c.id)).toEqual(['cl_web1']);
		expect(app.active?.turns.some((t) => t.clarificationId === 'cl_web2')).toBe(false);
		expect(app.pages.find((p) => p.urlKey === page.urlKey)?.askCount).toBe(1);

		// jsdom has no dialogs; the mock's confirm goes through window.confirm.
		window.confirm = () => true;
		await app.deletePage(page.urlKey);
		await settle(10);
		expect(app.pages.some((p) => p.urlKey === page.urlKey)).toBe(false);
		expect(app.conversations.some((c) => c.pageKey === page.urlKey)).toBe(false);
		expect(app.active?.pageKey ?? null).toBeNull();
	});

	it('dismisses the extension banner and reads the extension status', async () => {
		await app.init();
		expect(app.settings.extensionBannerSeen).toBe(false);
		await app.dismissExtensionBanner();
		expect(app.settings.extensionBannerSeen).toBe(true);
		await app.refreshExtensionStatus();
		expect(app.extension?.sessions[0]).toMatchObject({ browser: 'chrome', extensionVersion: '1.0.1' });
		await app.unregisterHosts();
		expect(app.extension?.browsers.every((b) => !b.registered)).toBe(true);
		await app.registerHosts();
		expect(app.extension?.browsers.find((b) => b.id === 'chrome')?.registered).toBe(true);
	});

	it('lists each browser whose extension is older than the bundled one, and dismisses the prompt', async () => {
		await app.refreshExtensionStatus();
		expect(app.outdatedExtensions).toEqual([]);
		const base = app.extension!;
		const session = (id: number, browser: string, extensionVersion: string) => ({ id, transport: 'native', browser, extensionVersion, connectedAt: 0 });
		app.extension = {
			...base,
			bundledVersion: '2.0.10',
			sessions: [session(1, 'firefox', '2.0.9'), session(2, 'firefox', '2.0.8'), session(3, 'chrome', '2.0.10'), session(4, 'safari', '2.0.6')]
		};
		expect(app.outdatedExtensions.map((s) => [s.browser, s.extensionVersion])).toEqual([
			['firefox', '2.0.8'],
			['safari', '2.0.6']
		]);
		app.dismissExtensionUpdate();
		expect(app.extensionUpdateDismissed).toBe('2.0.10');
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
