// Artifacts: self-contained pieces of work an agent writes inside an
// `<artifact id type title>` element, as the system note asks it to. They are
// pulled out of a reply's markdown before it is parsed into blocks, shown as a
// card in the transcript, and rendered in the artifact pane. Nothing is
// stored separately: the reply text is the source of truth, and versions are
// the replies in the conversation that reuse one id.

import type { Conversation } from '$lib/api/types';

export type ArtifactType = 'html' | 'svg' | 'mermaid' | 'markdown' | 'text' | 'code';

export interface Artifact {
	/** The agent's id; replies that reuse it are later versions. */
	identifier: string;
	type: ArtifactType;
	title: string;
	/** Language label for `code` artifacts, also used for highlighting. */
	lang: string;
	content: string;
	/** False while the closing tag has not arrived yet (streaming). */
	complete: boolean;
}

/** One version of an artifact: the artifact as a given turn wrote it. */
export interface ArtifactVersion extends Artifact {
	turnId: string;
	/** 1-based, in turn order. */
	version: number;
}

export interface ArtifactGroup {
	identifier: string;
	versions: ArtifactVersion[];
}

/** Placeholder a removed artifact leaves in the markdown. The private-use
 * characters keep the markdown lexer from touching it. */
export const PLACEHOLDER = '';
const PLACEHOLDER_RE = /^artifact:(\d+)$/;

/** The index an artifact placeholder paragraph stands for, if it is one. */
export function placeholderIndex(text: string): number | null {
	const m = PLACEHOLDER_RE.exec(text.trim());
	return m ? Number(m[1]) : null;
}

const TYPES: Record<string, ArtifactType> = {
	'text/html': 'html',
	html: 'html',
	'image/svg+xml': 'svg',
	svg: 'svg',
	'text/mermaid': 'mermaid',
	mermaid: 'mermaid',
	'text/markdown': 'markdown',
	markdown: 'markdown',
	md: 'markdown',
	'text/plain': 'text',
	text: 'text',
	'text/code': 'code',
	code: 'code',
	'application/vnd.ant.code': 'code',
	'application/vnd.ant.html': 'html',
	'application/vnd.ant.mermaid': 'mermaid'
};

const OPEN_TAG = /<artifact\b([^>]*)>\r?\n?/gi;
const CLOSE_TAG = /\r?\n?<\/artifact>/i;
const FENCE_OPEN_BEFORE = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n$/;
const FENCE_CLOSE_AFTER = /^\r?\n?[ \t]*(`{3,}|~{3,})[ \t]*(\r?\n|$)/;

function attr(attrs: string, name: string): string {
	const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
	return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
}

function typeOf(raw: string, lang: string): ArtifactType {
	const t = TYPES[raw.toLowerCase()];
	if (t) return t;
	if (!raw && lang) return 'code';
	return raw.startsWith('text/') || !raw ? 'text' : 'code';
}

/** Pulls every artifact element out of `text`. The returned text has a
 * placeholder paragraph where each artifact was; an artifact whose closing
 * tag is missing runs to the end of the text and is marked incomplete. A
 * code fence wrapped tightly around an artifact is dropped with it. */
export function extractArtifacts(text: string): { text: string; artifacts: Artifact[] } {
	const artifacts: Artifact[] = [];
	let out = '';
	let pos = 0;
	OPEN_TAG.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = OPEN_TAG.exec(text))) {
		const attrs = m[1];
		let before = text.slice(pos, m.index);
		const bodyStart = m.index + m[0].length;
		const rest = text.slice(bodyStart);
		const close = CLOSE_TAG.exec(rest);
		const content = close ? rest.slice(0, close.index) : rest;
		let after = close ? bodyStart + close.index + close[0].length : text.length;
		const fenceBefore = FENCE_OPEN_BEFORE.exec(before);
		if (fenceBefore) {
			const fenceAfter = FENCE_CLOSE_AFTER.exec(text.slice(after));
			if (fenceAfter || !close) {
				before = before.slice(0, fenceBefore.index + fenceBefore[1].length);
				if (fenceAfter) after += fenceAfter[0].length;
			}
		}
		const lang = attr(attrs, 'lang') || attr(attrs, 'language');
		const idx = artifacts.length;
		artifacts.push({
			identifier: attr(attrs, 'id') || attr(attrs, 'identifier') || `artifact-${idx + 1}`,
			type: typeOf(attr(attrs, 'type'), lang),
			title: attr(attrs, 'title') || 'Untitled artifact',
			lang,
			content,
			complete: !!close
		});
		out += `${before}\n\n${PLACEHOLDER}artifact:${idx}${PLACEHOLDER}\n\n`;
		pos = after;
		OPEN_TAG.lastIndex = after;
		if (!close) break;
	}
	out += text.slice(pos);
	return { text: fallbackArtifacts(out, artifacts), artifacts };
}

const FENCE_RE = /(^|\n)([ \t]*)(`{3,}|~{3,})[ \t]*(html|svg|mermaid)\b[^\n]*\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/g;
const TITLE_RE = /<title[^>]*>([^<]*)<\/title>/i;

/** Treats fenced blocks that hold a whole HTML document, an SVG image or a
 * Mermaid diagram as artifacts, for agents that ignore the artifact tag.
 * Each gets its own id, so these never form versions. */
function fallbackArtifacts(text: string, artifacts: Artifact[]): string {
	return text.replace(FENCE_RE, (whole, lead: string, _indent: string, _fence: string, lang: string, body: string) => {
		const kind = lang.toLowerCase();
		let type: ArtifactType;
		let title: string;
		if (kind === 'html') {
			if (!/<!doctype\s+html|<html[\s>]/i.test(body)) return whole;
			type = 'html';
			title = TITLE_RE.exec(body)?.[1].trim() || 'HTML page';
		} else if (kind === 'svg') {
			if (!/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(body)) return whole;
			type = 'svg';
			title = 'SVG image';
		} else {
			type = 'mermaid';
			title = 'Diagram';
		}
		const idx = artifacts.length;
		artifacts.push({ identifier: `fence-${idx + 1}`, type, title, lang: '', content: body, complete: true });
		return `${lead}\n${PLACEHOLDER}artifact:${idx}${PLACEHOLDER}\n`;
	});
}

/** Every artifact in the conversation grouped by id, versions in turn order.
 * Groups are ordered by the turn their first version appeared in. */
export function collectArtifacts(conv: Pick<Conversation, 'turns'>): ArtifactGroup[] {
	const groups = new Map<string, ArtifactGroup>();
	for (const t of conv.turns) {
		if (t.role !== 'assistant') continue;
		for (const a of extractArtifacts(t.text).artifacts) {
			const key = a.identifier;
			let g = groups.get(key);
			if (!g) {
				g = { identifier: key, versions: [] };
				groups.set(key, g);
			}
			g.versions.push({ ...a, turnId: t.id, version: g.versions.length + 1 });
		}
	}
	return [...groups.values()];
}

const EXT_BY_LANG: Record<string, string> = {
	javascript: 'js',
	typescript: 'ts',
	python: 'py',
	rust: 'rs',
	shell: 'sh',
	bash: 'sh',
	zsh: 'sh',
	markdown: 'md',
	'c++': 'cpp',
	kotlin: 'kt',
	yaml: 'yml',
	dockerfile: 'Dockerfile'
};

/** Extension for a saved artifact: by type, or by language for code. */
export function artifactExtension(a: Artifact): string {
	switch (a.type) {
		case 'html':
			return 'html';
		case 'svg':
			return 'svg';
		case 'mermaid':
			return 'mmd';
		case 'markdown':
			return 'md';
		case 'text':
			return 'txt';
		case 'code': {
			const l = a.lang.toLowerCase();
			return EXT_BY_LANG[l] ?? (/^[a-z0-9+]{1,10}$/.test(l) ? l : 'txt');
		}
	}
}

/** File name for saving an artifact, from its title. */
export function artifactFileName(a: Artifact): string {
	const base = a.title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
	return `${base || a.identifier || 'artifact'}.${artifactExtension(a)}`;
}

/** Short label for the card and pane. */
export function artifactTypeLabel(a: Artifact): string {
	switch (a.type) {
		case 'html':
			return 'HTML';
		case 'svg':
			return 'SVG';
		case 'mermaid':
			return 'Diagram';
		case 'markdown':
			return 'Document';
		case 'text':
			return 'Text';
		case 'code':
			return a.lang || 'Code';
	}
}

/** Highlighter language for the code tab. */
export function artifactLang(a: Artifact): string {
	switch (a.type) {
		case 'html':
			return 'html';
		case 'svg':
			return 'html';
		case 'markdown':
			return 'markdown';
		case 'code':
			return a.lang;
		default:
			return '';
	}
}

/** True for types the pane can show as something other than source. */
export function canPreview(a: Artifact): boolean {
	return a.type === 'html' || a.type === 'svg' || a.type === 'mermaid' || a.type === 'markdown';
}

/** Content security policy every preview frame starts with. Scripts and
 * network are opt-in and arrive through the frame's sandbox attribute and a
 * looser policy from `previewDocument`. */
export const PREVIEW_CSP_LOCKED = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";
export const PREVIEW_CSP_SCRIPTS = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; script-src 'unsafe-inline' 'unsafe-eval' blob:";
export const PREVIEW_CSP_OPEN = "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'";

/** Inserts a CSP meta tag at the start of the document's head so it governs
 * everything the agent wrote. A document without a head gets one. */
export function injectCsp(html: string, policy: string): string {
	const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
	const head = /<head\b[^>]*>/i.exec(html);
	if (head) return html.slice(0, head.index + head[0].length) + meta + html.slice(head.index + head[0].length);
	const open = /<html\b[^>]*>/i.exec(html);
	if (open) return html.slice(0, open.index + open[0].length) + `<head>${meta}</head>` + html.slice(open.index + open[0].length);
	return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

/** The document to load in a preview frame for an artifact. HTML is shown as
 * written; SVG and rendered diagrams are wrapped in a page that centres them. */
export function previewDocument(a: Artifact, opts: { scripts: boolean; network: boolean }, rendered?: string): string {
	const policy = opts.network ? PREVIEW_CSP_OPEN : opts.scripts ? PREVIEW_CSP_SCRIPTS : PREVIEW_CSP_LOCKED;
	if (a.type === 'html') return injectCsp(a.content, policy);
	const svg = rendered ?? a.content;
	const page = `<!doctype html><html><head><style>html,body{margin:0;height:100%;background:#fff}body{display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}svg{max-width:100%;max-height:100%}</style></head><body>${svg}</body></html>`;
	return injectCsp(page, PREVIEW_CSP_LOCKED);
}
