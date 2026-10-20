// Dotted version numbers, as the browser extensions report them.

/**
 * True when version `a` is older than `b`, comparing dotted numbers part by
 * part ("2.0.9" is older than "2.0.10"). A prerelease suffix ("2.1.0-beta")
 * is ignored, and an unreadable version is never called older.
 */
export function isOlder(a: string, b: string): boolean {
	const parse = (v: string) => {
		const parts = v.trim().split(/[-+]/)[0].split('.');
		return parts.every((p) => /^\d+$/.test(p)) ? parts.map(Number) : null;
	};
	const x = parse(a);
	const y = parse(b);
	if (!x || !y) return false;
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d !== 0) return d < 0;
	}
	return false;
}
