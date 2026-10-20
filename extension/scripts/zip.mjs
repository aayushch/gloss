// Zips each built target into dist/<target>.zip: chrome.zip goes to the
// Chrome Web Store, firefox.zip to Mozilla for signing, safari.zip to the
// macOS release build that wraps it with Xcode. Run `npm run build` first.

import { access, rm } from 'node:fs/promises';
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
	const r = spawnSync('zip', ['-qr', out, '.'], { cwd: dir, stdio: 'inherit' });
	if (r.status !== 0) process.exit(r.status ?? 1);
	console.log('wrote', path.relative(root, out));
}
