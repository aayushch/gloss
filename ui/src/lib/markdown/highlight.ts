// Syntax highlighting through Shiki, mapped onto the six colour roles the
// design defines (keyword, type, function, number, string, comment). The
// theme paints each role with a sentinel colour; tokens are then given the
// matching CSS class and the real colour comes from the --syn-* variables.

import { createHighlighterCore, type HighlighterCore, type ThemeRegistrationRaw } from 'shiki/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';

export interface Token {
	t: string;
	cls?: string;
}

const ROLE_COLORS: Record<string, string> = {
	'#000001': 'syn-kw',
	'#000002': 'syn-type',
	'#000003': 'syn-fn',
	'#000004': 'syn-num',
	'#000005': 'syn-str',
	'#000006': 'syn-cmt'
};

const THEME: ThemeRegistrationRaw = {
	name: 'gloss',
	type: 'light',
	colors: { 'editor.foreground': '#000000', 'editor.background': '#ffffff' },
	settings: [
		{ settings: { foreground: '#000000' } },
		{ scope: ['keyword', 'storage', 'keyword.operator.new', 'keyword.control', 'variable.language', 'constant.language', 'storage.type', 'storage.modifier', 'keyword.other'], settings: { foreground: '#000001' } },
		{ scope: ['entity.name.type', 'support.type', 'support.class', 'entity.name.class', 'entity.other.inherited-class', 'entity.name.tag', 'entity.name.namespace', 'storage.type.primitive', 'support.type.primitive', 'entity.other.attribute-name'], settings: { foreground: '#000002' } },
		{ scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function', 'variable.function', 'entity.name.function.macro'], settings: { foreground: '#000003' } },
		{ scope: ['constant.numeric', 'constant.language.boolean', 'constant.character'], settings: { foreground: '#000004' } },
		{ scope: ['string', 'string.quoted', 'punctuation.definition.string', 'constant.other.symbol'], settings: { foreground: '#000005' } },
		{ scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#000006' } }
	]
};

/** Languages that can be loaded on demand, keyed by the fence label. */
const LANGS: Record<string, { id: string; load: () => Promise<unknown> }> = {
	js: { id: 'javascript', load: () => import('shiki/langs/javascript.mjs') },
	javascript: { id: 'javascript', load: () => import('shiki/langs/javascript.mjs') },
	jsx: { id: 'jsx', load: () => import('shiki/langs/jsx.mjs') },
	ts: { id: 'typescript', load: () => import('shiki/langs/typescript.mjs') },
	typescript: { id: 'typescript', load: () => import('shiki/langs/typescript.mjs') },
	tsx: { id: 'tsx', load: () => import('shiki/langs/tsx.mjs') },
	json: { id: 'json', load: () => import('shiki/langs/json.mjs') },
	py: { id: 'python', load: () => import('shiki/langs/python.mjs') },
	python: { id: 'python', load: () => import('shiki/langs/python.mjs') },
	rs: { id: 'rust', load: () => import('shiki/langs/rust.mjs') },
	rust: { id: 'rust', load: () => import('shiki/langs/rust.mjs') },
	go: { id: 'go', load: () => import('shiki/langs/go.mjs') },
	c: { id: 'c', load: () => import('shiki/langs/c.mjs') },
	cpp: { id: 'cpp', load: () => import('shiki/langs/cpp.mjs') },
	'c++': { id: 'cpp', load: () => import('shiki/langs/cpp.mjs') },
	java: { id: 'java', load: () => import('shiki/langs/java.mjs') },
	kotlin: { id: 'kotlin', load: () => import('shiki/langs/kotlin.mjs') },
	kt: { id: 'kotlin', load: () => import('shiki/langs/kotlin.mjs') },
	swift: { id: 'swift', load: () => import('shiki/langs/swift.mjs') },
	sh: { id: 'shellscript', load: () => import('shiki/langs/shellscript.mjs') },
	bash: { id: 'shellscript', load: () => import('shiki/langs/shellscript.mjs') },
	shell: { id: 'shellscript', load: () => import('shiki/langs/shellscript.mjs') },
	zsh: { id: 'shellscript', load: () => import('shiki/langs/shellscript.mjs') },
	sql: { id: 'sql', load: () => import('shiki/langs/sql.mjs') },
	html: { id: 'html', load: () => import('shiki/langs/html.mjs') },
	css: { id: 'css', load: () => import('shiki/langs/css.mjs') },
	svelte: { id: 'svelte', load: () => import('shiki/langs/svelte.mjs') },
	yaml: { id: 'yaml', load: () => import('shiki/langs/yaml.mjs') },
	yml: { id: 'yaml', load: () => import('shiki/langs/yaml.mjs') },
	toml: { id: 'toml', load: () => import('shiki/langs/toml.mjs') },
	md: { id: 'markdown', load: () => import('shiki/langs/markdown.mjs') },
	markdown: { id: 'markdown', load: () => import('shiki/langs/markdown.mjs') },
	diff: { id: 'diff', load: () => import('shiki/langs/diff.mjs') },
	dockerfile: { id: 'dockerfile', load: () => import('shiki/langs/dockerfile.mjs') },
	docker: { id: 'dockerfile', load: () => import('shiki/langs/dockerfile.mjs') }
};

let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();
const loading = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
	if (!highlighter) {
		highlighter = createHighlighterCore({
			themes: [THEME],
			langs: [],
			engine: createJavaScriptRegexEngine({ forgiving: true })
		});
	}
	return highlighter;
}

async function ensureLang(id: string, load: () => Promise<unknown>): Promise<void> {
	if (loaded.has(id)) return;
	let p = loading.get(id);
	if (!p) {
		p = (async () => {
			const h = await getHighlighter();
			const mod = (await load()) as { default: unknown };
			await h.loadLanguage(mod.default as never);
			loaded.add(id);
		})();
		loading.set(id, p);
	}
	await p;
}

/** Plain, uncoloured lines for unknown languages or while a grammar loads. */
export function plainLines(code: string): Token[][] {
	return code.split('\n').map((l) => [{ t: l }]);
}

/** True when the fence label maps to a grammar Gloss can load. */
export function supportsLang(lang: string): boolean {
	return !!LANGS[lang.toLowerCase()];
}

export async function highlightLines(code: string, lang: string): Promise<Token[][]> {
	const entry = LANGS[lang.toLowerCase()];
	if (!entry) return plainLines(code);
	try {
		await ensureLang(entry.id, entry.load);
		const h = await getHighlighter();
		const { tokens } = h.codeToTokens(code, { lang: entry.id, theme: 'gloss' });
		return tokens.map((line) =>
			line.map((tok) => {
				const cls = tok.color ? ROLE_COLORS[tok.color.toLowerCase()] : undefined;
				return cls ? { t: tok.content, cls } : { t: tok.content };
			})
		);
	} catch {
		return plainLines(code);
	}
}
