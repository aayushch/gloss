// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

// Zips each built target into dist/<target>.zip: chrome.zip goes to the
// Chrome Web Store, firefox.zip to Mozilla for signing, safari.zip to the
// macOS release build that wraps it with Xcode. Run `npm run build` first.
//
// The store refuses a manifest with a `key` field, which only fixes the
// extension id of an unpacked copy, so chrome.zip is made from a copy of
// dist/chrome whose manifest has the key removed.

import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const target of ['chrome', 'firefox', 'safari']) {
	const dir = path.join(root, 'dist', target);
	try {
		await access(path.join(dir, 'manifest.json'));
	} catch {
		console.error(`dist/${target} is missing; run npm run build`);
		process.exit(1);
	}
	const out = path.join(root, 'dist', `${target}.zip`);
	await rm(out, { force: true });
	let src = dir;
	if (target === 'chrome') {
		src = await mkdtemp(path.join(os.tmpdir(), 'gloss-chrome-'));
		await cp(dir, src, { recursive: true });
		const manifestPath = path.join(src, 'manifest.json');
		const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
		delete manifest.key;
		await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
	}
	const r = spawnSync('zip', ['-qr', out, '.'], { cwd: src, stdio: 'inherit' });
	if (src !== dir) await rm(src, { recursive: true, force: true });
	if (r.status !== 0) process.exit(r.status ?? 1);
	console.log('wrote', path.relative(root, out));
}
