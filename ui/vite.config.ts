import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// Tauri sets TAURI_DEV_HOST when the dev server must listen on the network.
const host = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.TAURI_DEV_HOST;

export default defineConfig({
	plugins: [sveltekit()],
	// Tauri expects a fixed port and fails if it is taken.
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		host: host || false,
		watch: { ignored: ['**/src-tauri/**'] }
	},
	test: {
		environment: 'jsdom',
		include: ['src/**/*.test.ts']
	}
});
