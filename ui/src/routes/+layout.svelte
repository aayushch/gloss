<script lang="ts">
	import '../app.css';
	let { children } = $props();

	// The window chrome differs per platform: macOS hides the native title bar
	// and draws traffic lights over the rail, so the rail needs a spacer there
	// and nowhere else. Components read `data-platform` to adapt.
	$effect(() => {
		const ua = navigator.userAgent;
		const platform = /Mac/i.test(ua) ? 'macos' : /Win/i.test(ua) ? 'windows' : 'linux';
		document.documentElement.dataset.platform = platform;
	});
</script>

{@render children()}
