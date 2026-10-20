import { describe, expect, it } from 'vitest';
import { isOlder } from './version';

describe('isOlder', () => {
	it('compares part by part as numbers', () => {
		expect(isOlder('2.0.5', '2.0.6')).toBe(true);
		expect(isOlder('2.0.9', '2.0.10')).toBe(true);
		expect(isOlder('2.1.0', '2.0.10')).toBe(false);
		expect(isOlder('2.0.6', '2.0.6')).toBe(false);
		expect(isOlder('2.0', '2.0.1')).toBe(true);
	});

	it('ignores prerelease suffixes and never calls an unreadable version older', () => {
		expect(isOlder('2.0.6', '2.0.6-beta.1')).toBe(false);
		expect(isOlder('', '2.0.6')).toBe(false);
		expect(isOlder('dev', '2.0.6')).toBe(false);
	});
});
