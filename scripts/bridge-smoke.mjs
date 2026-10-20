#!/usr/bin/env node
// Drives the gloss-bridge native-messaging host the way a browser does:
// writes length-prefixed JSON frames to its stdin and prints the frames it
// answers with. Run with a Gloss app or `gloss-engine serve` up to see real
// replies, or without one to see the app_not_running error.
//
//   node scripts/bridge-smoke.mjs [path/to/gloss-bridge] [method] [json params]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [process.argv[2], path.join(root, 'target/debug/gloss-bridge'), path.join(root, 'target/release/gloss-bridge')].filter(Boolean);
const bin = candidates.find((p) => existsSync(p));
if (!bin) {
	console.error('gloss-bridge binary not found; run cargo build -p gloss-bridge');
	process.exit(2);
}
const method = process.argv[3] ?? 'getPage';
const params = JSON.parse(process.argv[4] ?? '{"url":"https://example.com/a?utm_source=smoke"}');

const child = spawn(bin, ['chrome-extension://smoke/'], { stdio: ['pipe', 'pipe', 'inherit'] });
function frame(obj) {
	const body = Buffer.from(JSON.stringify(obj), 'utf8');
	const len = Buffer.alloc(4);
	len.writeUInt32LE(body.length, 0);
	return Buffer.concat([len, body]);
}
let pending = Buffer.alloc(0);
let answered = 0;
child.stdout.on('data', (chunk) => {
	pending = Buffer.concat([pending, chunk]);
	while (pending.length >= 4) {
		const len = pending.readUInt32LE(0);
		if (pending.length < 4 + len) break;
		const msg = JSON.parse(pending.subarray(4, 4 + len).toString('utf8'));
		pending = pending.subarray(4 + len);
		console.log(JSON.stringify(msg));
		if (msg.id === '1' || msg.id === '2') answered++;
		if (answered === 2) {
			child.stdin.end();
		}
	}
});
child.on('exit', (code) => process.exit(code ?? 0));
child.stdin.write(frame({ id: '1', method: 'hello', params: { protocol: 1, browser: 'smoke', extensionVersion: '0' } }));
child.stdin.write(frame({ id: '2', method, params }));
setTimeout(() => {
	console.error('timed out');
	child.kill();
	process.exit(1);
}, 10000);
