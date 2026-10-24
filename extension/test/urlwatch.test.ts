// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchUrl } from '../src/content/urlwatch';

describe('watchUrl', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('reports pushState, replaceState, popstate and hashchange once each', () => {
		const seen: string[] = [];
		const stop = watchUrl((href) => seen.push(href));
		history.pushState({}, '', '/one');
		vi.advanceTimersByTime(150);
		history.replaceState({}, '', '/two');
		vi.advanceTimersByTime(150);
		location.hash = '#part';
		window.dispatchEvent(new Event('hashchange'));
		vi.advanceTimersByTime(150);
		history.pushState({}, '', '/three');
		window.dispatchEvent(new PopStateEvent('popstate'));
		vi.advanceTimersByTime(150);
		expect(seen.map((h) => new URL(h).pathname + new URL(h).hash)).toEqual([
			'/one',
			'/two',
			'/two#part',
			'/three'
		]);
		stop();
	});

	it('coalesces bursts and ignores unchanged hrefs', () => {
		const seen: string[] = [];
		const stop = watchUrl((href) => seen.push(href));
		history.pushState({}, '', '/a');
		history.pushState({}, '', '/b');
		history.replaceState({}, '', '/c');
		vi.advanceTimersByTime(150);
		history.replaceState({}, '', '/c');
		vi.advanceTimersByTime(150);
		expect(seen.map((h) => new URL(h).pathname)).toEqual(['/c']);
		stop();
	});

	it('restores history methods when stopped', () => {
		const push = history.pushState;
		const stop = watchUrl(() => {});
		expect(history.pushState).not.toBe(push);
		stop();
		expect(history.pushState).toBe(push);
	});
});
