// Derives the clarification threads of a conversation from its flat turn
// list, and provides the small formatting helpers the transcript and rail
// share.

import type { AgentId, Clarification, Conversation, ConversationSummary, ExternalSession, Project, Turn } from '$lib/api/types';

export interface ThreadTurn {
	question: Turn;
	reply: Turn | undefined;
}

export interface Thread {
	clarification: Clarification;
	turns: ThreadTurn[];
}

/** Clarification id → its question/reply pairs in order. */
export function buildThreads(conv: Conversation): Map<string, Thread> {
	const map = new Map<string, Thread>();
	for (const cl of conv.clarifications) map.set(cl.id, { clarification: cl, turns: [] });
	for (const t of conv.turns) {
		if (!t.clarificationId) continue;
		const th = map.get(t.clarificationId);
		if (!th) continue;
		if (t.role === 'user') th.turns.push({ question: t, reply: undefined });
		else {
			const last = th.turns[th.turns.length - 1];
			if (last && !last.reply) last.reply = t;
			else th.turns.push({ question: t, reply: t });
		}
	}
	return map;
}

/** Turn id part of a block id (`<turnId>:<index>`). */
export function turnOfBlock(blockId: string): string {
	return blockId.slice(0, blockId.lastIndexOf(':'));
}

/** The top-level assistant turn a clarification ultimately hangs off. */
export function rootTurnOf(cl: Clarification, all: Clarification[]): string {
	let cur: Clarification | undefined = cl;
	const seen = new Set<string>();
	while (cur?.parentId && !seen.has(cur.id)) {
		seen.add(cur.id);
		cur = all.find((c) => c.id === cur!.parentId);
	}
	return cur ? turnOfBlock(cur.anchorBlockId) : turnOfBlock(cl.anchorBlockId);
}

export function pad(n: number): string {
	return String(n).padStart(2, '0');
}

export function short(s: string, n = 44): string {
	const flat = s.replace(/\s+/g, ' ').trim();
	return flat.length > n ? flat.slice(0, n).trim() + '…' : flat;
}

export function turnsLabel(n: number): string {
	return `${n} ${n === 1 ? 'turn' : 'turns'}`;
}

export function relativeTime(ms: number): string {
	const diff = Date.now() - ms;
	const m = Math.round(diff / 60_000);
	if (m < 1) return 'just now';
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h} h ago`;
	const d = Math.round(h / 24);
	if (d === 1) return 'yesterday';
	return `${d} d ago`;
}

export type Group = 'Today' | 'Yesterday' | 'Last week' | 'Older';

export function groupOf(ms: number): Group {
	const d = new Date(ms);
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const start = today.getTime();
	if (d.getTime() >= start) return 'Today';
	if (d.getTime() >= start - 86_400_000) return 'Yesterday';
	if (d.getTime() >= start - 7 * 86_400_000) return 'Last week';
	return 'Older';
}

/** Plain text and nesting context of every rendered block, keyed by block id. */
export const blockRegistry = new Map<string, { text: string; parentId: string | null; kind: string }>();

/** Ids of the clarifications whose question, reply or quoted text contains
 * `query` (case-insensitive, whitespace collapsed). Find uses it to open the
 * wells a match is hiding in, since a collapsed well renders no text. */
export function wellsContaining(conv: Conversation, query: string): string[] {
	const flat = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
	const q = flat(query);
	if (!q) return [];
	const hit = new Set<string>();
	for (const cl of conv.clarifications) if (flat(cl.quote).includes(q)) hit.add(cl.id);
	for (const t of conv.turns) if (t.clarificationId && flat(t.text).includes(q)) hit.add(t.clarificationId);
	return [...hit];
}

/** Conversations split for the rail: those bound to one of `projects`, by
 * project path, and the rest. A conversation whose folder is not a project
 * (the project was removed) goes with the rest. Order within each list is
 * kept. */
export function splitByProject(
	conversations: ConversationSummary[],
	projects: Project[]
): { byProject: Map<string, ConversationSummary[]>; rest: ConversationSummary[] } {
	const byProject = new Map<string, ConversationSummary[]>(projects.map((p) => [p.path, []]));
	const rest: ConversationSummary[] = [];
	for (const c of conversations) {
		const list = c.projectDir ? byProject.get(c.projectDir) : undefined;
		if (list) list.push(c);
		else rest.push(c);
	}
	return { byProject, rest };
}

/** One entry in a project's rail list: a Gloss conversation, or a session
 * the agent recorded outside Gloss. */
export type ProjectItem = { kind: 'chat'; chat: ConversationSummary } | { kind: 'session'; session: ExternalSession };

/** A project's entries: pinned conversations first, then conversations and
 * outside sessions together, newest first. `agent`, when set, keeps only
 * that agent's entries. */
export function projectItems(chats: ConversationSummary[], sessions: ExternalSession[], agent: AgentId | null): ProjectItem[] {
	const keep = (a: AgentId) => !agent || a === agent;
	const pinned: ProjectItem[] = chats.filter((c) => c.pinned && keep(c.agent)).map((chat) => ({ kind: 'chat', chat }));
	const rest = [
		...chats.filter((c) => !c.pinned && keep(c.agent)).map((chat) => ({ at: chat.updatedAt, item: { kind: 'chat', chat } as ProjectItem })),
		...sessions.filter((s) => keep(s.agent)).map((session) => ({ at: session.updatedAt, item: { kind: 'session', session } as ProjectItem }))
	].sort((a, b) => b.at - a.at);
	return [...pinned, ...rest.map((r) => r.item)];
}

/** The agents that have an entry in a project, in AgentId order. */
export function agentsIn(chats: ConversationSummary[], sessions: ExternalSession[]): AgentId[] {
	const present = new Set<AgentId>([...chats.map((c) => c.agent), ...sessions.map((s) => s.agent)]);
	return (['claude', 'codex', 'gemini', 'pi', 'cursor'] as AgentId[]).filter((a) => present.has(a));
}
