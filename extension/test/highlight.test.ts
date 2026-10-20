import { describe, expect, it } from 'vitest';
import { clipBox, mergeRects } from '../src/content/highlight';

describe('mergeRects', () => {
	it('joins the pieces of one line into one box', () => {
		const boxes = mergeRects([
			{ left: 10, top: 100, right: 50, bottom: 118 },
			{ left: 50, top: 101, right: 90, bottom: 119 },
			{ left: 92, top: 100, right: 120, bottom: 118 },
		]);
		expect(boxes).toEqual([{ left: 10, top: 100, right: 120, bottom: 119 }]);
	});

	it('keeps separate lines apart and drops empty rects', () => {
		const boxes = mergeRects([
			{ left: 10, top: 100, right: 300, bottom: 118 },
			{ left: 10, top: 120, right: 200, bottom: 138 },
			{ left: 200, top: 120, right: 200, bottom: 138 },
		]);
		expect(boxes).toHaveLength(2);
		expect(boxes[1]).toEqual({ left: 10, top: 120, right: 200, bottom: 138 });
	});

	it('does not join pieces with a gap between them', () => {
		const boxes = mergeRects([
			{ left: 10, top: 100, right: 50, bottom: 118 },
			{ left: 80, top: 100, right: 120, bottom: 118 },
		]);
		expect(boxes).toHaveLength(2);
	});
});

describe('clipBox', () => {
	it('cuts a box down to the clip and drops what is outside', () => {
		const clip = { left: 0, top: 0, right: 100, bottom: 100 };
		expect(clipBox({ left: 50, top: 90, right: 150, bottom: 120 }, clip)).toEqual({ left: 50, top: 90, right: 100, bottom: 100 });
		expect(clipBox({ left: 120, top: 0, right: 150, bottom: 50 }, clip)).toBeNull();
	});
});
