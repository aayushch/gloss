// Writes the extension icons (16, 32, 48 and 128 px) with pngjs: a rounded
// square in the Gloss accent colour with a white opening quote mark. Each
// pixel is supersampled 4x4 so the edges stay smooth at every size.

import { PNG } from 'pngjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(root, '..', 'icons');
const ACCENT = [194, 65, 12];
const SS = 4;

/** True when the unit-square point lies inside the rounded background. */
function inSquare(x, y) {
	const r = 0.22;
	const cx = Math.min(Math.max(x, r), 1 - r);
	const cy = Math.min(Math.max(y, r), 1 - r);
	return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Points along a quadratic bezier, used to draw each quote mark's tail. */
function bezier(p0, p1, p2, steps) {
	const pts = [];
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const a = (1 - t) ** 2;
		const b = 2 * (1 - t) * t;
		const c = t * t;
		pts.push([a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1], t]);
	}
	return pts;
}

/** One mark of the “ glyph: a ball with a tail rising from it, like a 6. */
function markAt(cx) {
	const ball = [cx, 0.56];
	const r = 0.085;
	const tail = bezier([cx + r * 0.6, 0.47], [cx + r * 1.6, 0.36], [cx + r * 0.2, 0.28], 24);
	return (x, y) => {
		if ((x - ball[0]) ** 2 + (y - ball[1]) ** 2 <= r * r) return true;
		for (const [px, py, t] of tail) {
			const w = r * (0.85 - 0.6 * t);
			if ((x - px) ** 2 + (y - py) ** 2 <= w * w) return true;
		}
		return false;
	};
}

const marks = [markAt(0.36), markAt(0.62)];

function render(size) {
	const png = new PNG({ width: size, height: size });
	for (let py = 0; py < size; py++) {
		for (let px = 0; px < size; px++) {
			let bg = 0;
			let fg = 0;
			for (let sy = 0; sy < SS; sy++) {
				for (let sx = 0; sx < SS; sx++) {
					const x = (px + (sx + 0.5) / SS) / size;
					const y = (py + (sy + 0.5) / SS) / size;
					if (!inSquare(x, y)) continue;
					bg++;
					if (marks.some((m) => m(x, y))) fg++;
				}
			}
			const total = SS * SS;
			const alpha = bg / total;
			const white = bg ? fg / bg : 0;
			const i = (py * size + px) * 4;
			png.data[i] = Math.round(ACCENT[0] + (255 - ACCENT[0]) * white);
			png.data[i + 1] = Math.round(ACCENT[1] + (255 - ACCENT[1]) * white);
			png.data[i + 2] = Math.round(ACCENT[2] + (255 - ACCENT[2]) * white);
			png.data[i + 3] = Math.round(alpha * 255);
		}
	}
	return PNG.sync.write(png);
}

await mkdir(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
	await writeFile(path.join(outDir, `icon${size}.png`), render(size));
}
console.log('icons written to', outDir);
