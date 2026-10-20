// Reports URL changes that happen without a page load: pushState and
// replaceState calls, back/forward navigation and hash changes. Changes
// are coalesced over 100 ms and reported once per new href.

export type UrlListener = (href: string) => void;

const DEBOUNCE_MS = 100;

/** Starts watching; returns a function that stops watching and restores history. */
export function watchUrl(listener: UrlListener, win: Window = window): () => void {
	const history = win.history;
	const origPush = history.pushState;
	const origReplace = history.replaceState;
	let last = win.location.href;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const schedule = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			const href = win.location.href;
			if (href !== last) {
				last = href;
				listener(href);
			}
		}, DEBOUNCE_MS);
	};

	history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
		const r = origPush.apply(this, args);
		schedule();
		return r;
	};
	history.replaceState = function (this: History, ...args: Parameters<History['replaceState']>) {
		const r = origReplace.apply(this, args);
		schedule();
		return r;
	};
	win.addEventListener('popstate', schedule);
	win.addEventListener('hashchange', schedule);

	return () => {
		history.pushState = origPush;
		history.replaceState = origReplace;
		win.removeEventListener('popstate', schedule);
		win.removeEventListener('hashchange', schedule);
		if (timer) clearTimeout(timer);
	};
}
