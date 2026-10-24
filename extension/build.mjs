// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

// Builds the extension for one or every browser target with esbuild.
//
//   node build.mjs --target chrome|firefox|safari|all [--watch]
//
// Each target gets its own dist/<target> folder: the bundled scripts, the
// HTML pages, the icons (rendered into icons/ by scripts/icons.sh at the
// repository root, from the same source as the app icon) and
// manifests/<target>.json copied to manifest.json.
// The `__BROWSER__` define tells the code which browser it runs in.

import * as esbuild from 'esbuild';
import sveltePlugin from 'esbuild-svelte';
import { cp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const watch = args.includes('--watch');
const targetArg = args[args.indexOf('--target') + 1] ?? 'chrome';
const targets = targetArg === 'all' ? ['chrome', 'firefox', 'safari'] : [targetArg];

for (const t of targets) {
	if (!['chrome', 'firefox', 'safari'].includes(t)) {
		console.error(`unknown target ${t}`);
		process.exit(1);
	}
}

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

/** Shared esbuild options for one target. */
function common(target) {
	return {
		bundle: true,
		format: 'iife',
		target: ['chrome120', 'firefox128', 'safari17'],
		sourcemap: watch ? 'inline' : false,
		minify: false,
		logLevel: 'info',
		define: {
			__BROWSER__: JSON.stringify(target),
			'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production')
		},
		conditions: ['svelte', 'browser', watch ? 'development' : 'production'],
		plugins: [sveltePlugin({ compilerOptions: { runes: true, css: 'external', dev: watch } })]
	};
}

/** Copies the static files of one target into its dist folder. */
async function copyStatic(target) {
	const out = path.join(root, 'dist', target);
	await mkdir(path.join(out, 'icons'), { recursive: true });
	const manifest = JSON.parse(
		await readFile(path.join(root, 'manifests', `${target}.json`), 'utf8')
	);
	manifest.version = pkg.version;
	await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
	for (const page of ['popup', 'options', 'ask']) {
		await cp(path.join(root, 'src', page, `${page}.html`), path.join(out, `${page}.html`));
	}
	await cp(path.join(root, 'icons'), path.join(out, 'icons'), { recursive: true });
}

async function buildTarget(target) {
	const out = path.join(root, 'dist', target);
	await rm(out, { recursive: true, force: true });
	await mkdir(out, { recursive: true });
	await copyStatic(target);

	// The content script carries its stylesheet as a string and injects it
	// into its shadow root, so its build loads .css files as text.
	const content = await esbuild.context({
		...common(target),
		entryPoints: {
			content: path.join(root, 'src/content/index.ts'),
			guard: path.join(root, 'src/content/guard.ts'),
			pageguard: path.join(root, 'src/content/pageguard.ts')
		},
		outdir: out,
		loader: { '.css': 'text' }
	});
	const rest = await esbuild.context({
		...common(target),
		entryPoints: {
			background: path.join(root, 'src/background/index.ts'),
			popup: path.join(root, 'src/popup/main.ts'),
			options: path.join(root, 'src/options/main.ts'),
			ask: path.join(root, 'src/ask/main.ts')
		},
		outdir: out
	});

	if (watch) {
		await Promise.all([content.watch(), rest.watch()]);
		console.log(`[${target}] watching`);
	} else {
		await Promise.all([content.rebuild(), rest.rebuild()]);
		await Promise.all([content.dispose(), rest.dispose()]);
		console.log(`[${target}] built dist/${target}`);
	}
}

for (const target of targets) {
	await buildTarget(target);
}
