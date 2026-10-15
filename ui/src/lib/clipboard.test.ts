import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

describe('copyText', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
	});

	it('uses the async clipboard API when present', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		expect(await copyText('hello')).toBe(true);
		expect(writeText).toHaveBeenCalledWith('hello');
	});

	it('falls back to the legacy copy command', async () => {
		Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
		document.execCommand = vi.fn().mockReturnValue(true);
		expect(await copyText('hello')).toBe(true);
		expect(document.execCommand).toHaveBeenCalledWith('copy');
		expect(document.querySelector('textarea')).toBeNull();
	});
});
