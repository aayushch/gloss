import { describe, expect, it } from 'vitest';
import { artifactFileName, collectArtifacts, extractArtifacts, injectCsp, previewDocument } from './artifacts';
import { parseBlocks } from './blocks';
import { blocksToMarkdown } from './export';

const PAGE = '<!doctype html>\n<html><head><title>Hi</title></head><body><h1>Hi</h1></body></html>';

describe('extractArtifacts', () => {
	it('pulls a tagged artifact out and leaves a placeholder', () => {
		const text = `Here is the page.\n\n<artifact id="hello-page" type="text/html" title="Hello page">\n${PAGE}\n</artifact>\n\nLet me know.`;
		const { text: rest, artifacts } = extractArtifacts(text);
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0]).toMatchObject({ identifier: 'hello-page', type: 'html', title: 'Hello page', content: PAGE, complete: true });
		expect(rest).toContain('Here is the page.');
		expect(rest).toContain('Let me know.');
		expect(rest).toContain('artifact:0');
		expect(rest).not.toContain('<artifact');
	});

	it('marks an unterminated artifact as incomplete and keeps streaming text', () => {
		const { artifacts } = extractArtifacts('Sure.\n\n<artifact id="x" type="text/plain" title="Notes">\nline one\nline tw');
		expect(artifacts[0].complete).toBe(false);
		expect(artifacts[0].content).toBe('line one\nline tw');
	});

	it('drops a code fence wrapped around an artifact', () => {
		const text = 'Done:\n\n```html\n<artifact id="a" type="text/html" title="A">\n<p>x</p>\n</artifact>\n```\n\nEnd.';
		const { text: rest, artifacts } = extractArtifacts(text);
		expect(artifacts[0].content).toBe('<p>x</p>');
		expect(rest).not.toContain('```');
		expect(rest).toContain('End.');
	});

	it('reads code artifacts with a lang attribute and single quotes', () => {
		const { artifacts } = extractArtifacts("<artifact id='s' type='text/code' lang='python' title='Script'>\nprint(1)\n</artifact>");
		expect(artifacts[0]).toMatchObject({ type: 'code', lang: 'python', title: 'Script' });
		expect(artifactFileName(artifacts[0])).toBe('script.py');
	});

	it('turns whole-document html, svg and mermaid fences into artifacts', () => {
		const text = `Page:\n\n\`\`\`html\n${PAGE}\n\`\`\`\n\nSnippet:\n\n\`\`\`html\n<p>just a bit</p>\n\`\`\`\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\`\n`;
		const { text: rest, artifacts } = extractArtifacts(text);
		expect(artifacts.map((a) => a.type)).toEqual(['html', 'mermaid']);
		expect(artifacts[0].title).toBe('Hi');
		expect(rest).toContain('<p>just a bit</p>');
	});

	it('leaves text without artifacts untouched', () => {
		const text = 'Plain **markdown** with `code`.';
		expect(extractArtifacts(text)).toEqual({ text, artifacts: [] });
	});
});

describe('parseBlocks with artifacts', () => {
	it('yields an artifact block in place and keeps block indexes stable', () => {
		const text = `Intro\n\n<artifact id="a" type="image/svg+xml" title="Dot">\n<svg xmlns="http://www.w3.org/2000/svg"/>\n</artifact>\n\nOutro`;
		const blocks = parseBlocks(text, 'T');
		expect(blocks.map((b) => b.kind)).toEqual(['p', 'artifact', 'p']);
		expect(blocks[1].id).toBe('T:1');
		expect(blocks[1].artifact?.title).toBe('Dot');
	});

	it('exports an artifact block as a titled fence', () => {
		const blocks = parseBlocks('<artifact id="a" type="text/markdown" title="Memo">\n# Hello\n</artifact>', 'T');
		expect(blocksToMarkdown(blocks)).toBe('**Memo**\n\n```md\n# Hello\n```');
	});
});

describe('collectArtifacts', () => {
	it('groups versions by id in turn order', () => {
		const turn = (id: string, text: string) => ({ id, role: 'assistant' as const, text });
		const groups = collectArtifacts({
			turns: [
				turn('t1', '<artifact id="app" type="text/html" title="App v1">\n<p>1</p>\n</artifact>') as never,
				turn('t2', '<artifact id="other" type="text/plain" title="Other">\nx\n</artifact>') as never,
				turn('t3', '<artifact id="app" type="text/html" title="App v2">\n<p>2</p>\n</artifact>') as never
			]
		});
		expect(groups.map((g) => g.identifier)).toEqual(['app', 'other']);
		expect(groups[0].versions.map((v) => [v.version, v.turnId, v.title])).toEqual([
			[1, 't1', 'App v1'],
			[2, 't3', 'App v2']
		]);
	});
});

describe('preview documents', () => {
	it('injects the policy at the top of an existing head', () => {
		const out = injectCsp(PAGE, "default-src 'none'");
		expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<title>'));
		expect(out.startsWith('<!doctype html>')).toBe(true);
	});

	it('wraps a bare fragment in a document with a head', () => {
		const out = injectCsp('<p>hi</p>', "default-src 'none'");
		expect(out).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/);
		expect(out).toContain('<body><p>hi</p></body>');
	});

	it('locks scripts and network down unless asked', () => {
		const a = { identifier: 'a', type: 'html' as const, title: '', lang: '', content: PAGE, complete: true };
		expect(previewDocument(a, { scripts: false, network: false })).toContain("default-src 'none'");
		expect(previewDocument(a, { scripts: false, network: false })).not.toContain('script-src');
		expect(previewDocument(a, { scripts: true, network: false })).toContain("script-src 'unsafe-inline'");
		expect(previewDocument(a, { scripts: true, network: true })).toContain('default-src * ');
		const svg = { ...a, type: 'svg' as const, content: '<svg/>' };
		expect(previewDocument(svg, { scripts: true, network: true })).toContain("default-src 'none'");
	});
});
