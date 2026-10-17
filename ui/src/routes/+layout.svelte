<script lang="ts">
	import '../app.css';
	let { children } = $props();

	// On macOS the native title bar is a transparent band in the page colour,
	// with nothing drawn between it and the page. The shell draws a hairline
	// under it so the rail and its divider read as panes that start below a
	// toolbar; elsewhere the native title bar carries its own edge.
	$effect(() => {
		const ua = navigator.userAgent;
		document.documentElement.dataset.platform = /Mac/i.test(ua) ? 'macos' : /Win/i.test(ua) ? 'windows' : 'linux';
	});
</script>

{@render children()}
