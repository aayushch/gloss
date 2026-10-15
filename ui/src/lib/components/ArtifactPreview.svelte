<script lang="ts">
	// Renders an artifact's preview. HTML, SVG and diagrams load in a sandboxed
	// iframe with an opaque origin, so nothing in them can reach the app or its
	// IPC bridge. Scripts and network access are off until the user turns them
	// on for HTML. Markdown renders in the app's own read-only renderer.
	import { previewDocument, type Artifact } from '$lib/markdown/artifacts';
	import MarkdownView from './MarkdownView.svelte';

	let { artifact, scripts = false, network = false }: { artifact: Artifact; scripts?: boolean; network?: boolean } = $props();

	let rendered = $state<string | null>(null);
	let error = $state<string | null>(null);
	let seq = 0;

	// Mermaid source becomes an SVG string first; the SVG then loads in the
	// same sandboxed frame as any other image.
	$effect(() => {
		if (artifact.type !== 'mermaid') {
			rendered = null;
			error = null;
			return;
		}
		const code = artifact.content;
		const mine = ++seq;
		rendered = null;
		error = null;
		import('mermaid')
			.then(async (m) => {
				const mermaid = m.default;
				mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', fontFamily: 'IBM Plex Sans, system-ui, sans-serif' });
				const { svg } = await mermaid.render(`mmd-${mine}`, code);
				if (mine === seq) rendered = svg;
			})
			.catch((e) => {
				if (mine === seq) error = String(e?.message ?? e).split('\n')[0];
			});
	});

	const doc = $derived.by(() => {
		if (artifact.type === 'markdown') return null;
		if (artifact.type === 'mermaid' && !rendered) return null;
		return previewDocument(artifact, { scripts, network }, rendered ?? undefined);
	});

	// `allow-same-origin` must never be added: with it the frame would share
	// the app's origin and could call Tauri commands.
	const sandbox = $derived(artifact.type === 'html' && scripts ? 'allow-scripts allow-forms allow-modals' : 'allow-forms');
</script>

{#if artifact.type === 'markdown'}
	<div class="scroll"><MarkdownView text={artifact.content} /></div>
{:else if error}
	<div class="msg">The diagram could not be rendered: {error}</div>
{:else if doc === null}
	<div class="msg">Rendering…</div>
{:else}
	<iframe title={artifact.title} {sandbox} srcdoc={doc} referrerpolicy="no-referrer"></iframe>
{/if}

<style>
	iframe {
		width: 100%;
		height: 100%;
		border: 0;
		background: #fff;
		display: block;
	}
	.scroll {
		height: 100%;
		overflow-y: auto;
		padding: 20px 24px;
	}
	.msg {
		padding: 24px;
		font-size: 13px;
		color: var(--text-3);
	}
</style>
