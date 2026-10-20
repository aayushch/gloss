import { describe, expect, it } from 'vitest';
import { fractionOf, NAV_HEIGHT, NAV_WIDTH, obstruction, placeOnEdge, topOf, type HitTest } from '../src/content/dock';

const W = 1200;
const H = 800;

/** A hit test that finds `el` inside the given viewport boxes and the body everywhere else. */
function hitsIn(boxes: { top: number; bottom: number; el: Element }[]): HitTest {
	return (_x, y) => boxes.find((b) => y >= b.top && y <= b.bottom)?.el ?? document.body;
}

describe('obstruction', () => {
	it('counts only elements pinned to the screen, controls in them most', () => {
		document.body.innerHTML = `
			<p id="text">words</p>
			<a id="link" href="#">go</a>
			<div id="bar" style="position: fixed"><span id="label">banner</span><button id="chat">chat</button></div>
			<div style="position: sticky"><span id="side">aside</span></div>`;
		const $ = (id: string) => document.getElementById(id)!;
		expect(obstruction(document.body)).toBe(0);
		expect(obstruction($('text'))).toBe(0);
		// A link that scrolls with the page moves out from under the navigator on its own.
		expect(obstruction($('link'))).toBe(0);
		expect(obstruction($('label'))).toBeGreaterThan(0);
		expect(obstruction($('side'))).toBeGreaterThan(0);
		expect(obstruction($('chat'))).toBeGreaterThan(obstruction($('label')));
	});
});

describe('placeOnEdge', () => {
	it('docks on the right edge at the middle by default', () => {
		const p = placeOnEdge(W, H, 0.5, hitsIn([]));
		expect(p.left + NAV_WIDTH).toBeLessThan(W);
		expect(p.left).toBeGreaterThan(W - NAV_WIDTH - 40);
		expect(Math.abs(p.top + NAV_HEIGHT / 2 - H / 2)).toBeLessThanOrEqual(1);
	});

	it("keeps the reader's height when nothing pinned is there", () => {
		expect(placeOnEdge(W, H, 0.2, hitsIn([])).top).toBe(topOf(0.2, H));
	});

	it('slides along the edge to the nearest clear height past a pinned widget', () => {
		document.body.innerHTML = '<div id="w" style="position: fixed">widget</div>';
		const widget = { top: 360, bottom: 440, el: document.getElementById('w')! };
		const p = placeOnEdge(W, H, 0.5, hitsIn([widget]));
		const clear = p.top + NAV_HEIGHT < widget.top || p.top > widget.bottom;
		expect(clear).toBe(true);
		// Nearest: within one navigator height plus clearance of the widget's edge.
		expect(Math.min(Math.abs(widget.top - (p.top + NAV_HEIGHT)), Math.abs(p.top - widget.bottom))).toBeLessThanOrEqual(12);
		expect(p.left).toBe(placeOnEdge(W, H, 0.5, hitsIn([])).left);
	});

	it('stays put when the only thing underneath scrolls with the page', () => {
		document.body.innerHTML = '<a id="l" href="#">link</a>';
		const p = placeOnEdge(W, H, 0.5, hitsIn([{ top: 0, bottom: H, el: document.getElementById('l')! }]));
		expect(p.top).toBe(topOf(0.5, H));
	});
});

describe('height fractions', () => {
	it('round-trip and stay inside the viewport', () => {
		expect(fractionOf(topOf(0.3, H), H)).toBeCloseTo(0.3, 2);
		expect(topOf(-1, H)).toBe(16);
		expect(topOf(2, H)).toBe(H - NAV_HEIGHT - 16);
	});
});
