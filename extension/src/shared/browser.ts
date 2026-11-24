// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

// The WebExtension API object. Firefox and Safari expose the promise-based
// `browser` namespace; Chrome's MV3 `chrome` namespace returns promises too
// when no callback is passed, so both can be used through one name.

export const browser: typeof chrome = ((globalThis as { browser?: typeof chrome }).browser ??
	chrome) as typeof chrome;

/** The extension's version from its manifest. */
export function extensionVersion(): string {
	try {
		return browser.runtime.getManifest().version;
	} catch {
		return '0.0.0';
	}
}

/** Reads one key from session storage, or local storage where session storage is missing. */
export async function storageGet<T>(key: string): Promise<T | undefined> {
	const area = browser.storage.session ?? browser.storage.local;
	try {
		const r = await area.get(key);
		return r[key] as T | undefined;
	} catch {
		return undefined;
	}
}

export async function storageSet(key: string, value: unknown): Promise<void> {
	const area = browser.storage.session ?? browser.storage.local;
	try {
		await area.set({ [key]: value });
	} catch {
		// Storage can be unavailable in some contexts; the value is only a cache.
	}
}

/** Reads one key from local storage, which keeps it across browser restarts. */
export async function localGet<T>(key: string): Promise<T | undefined> {
	try {
		const r = await browser.storage.local.get(key);
		return r[key] as T | undefined;
	} catch {
		return undefined;
	}
}

export async function localSet(key: string, value: unknown): Promise<void> {
	try {
		await browser.storage.local.set({ [key]: value });
	} catch {
		// Storage can be unavailable in some contexts; the value is a preference only.
	}
}

/**
 * Local storage key of the "Show notes on pages" switch in the toolbar
 * popup. The value is `true` while the switch is off and notes are hidden
 * on every page. A missing value means notes are shown.
 */
export const NOTES_HIDDEN_KEY = 'notesHidden';

/**
 * Calls `fn` with the new value each time `key` is written in local
 * storage, whichever extension page or tab wrote it. The value is
 * undefined when the key was removed. Returns a function that stops the
 * calls.
 */
export function onLocalChange<T>(key: string, fn: (value: T | undefined) => void): () => void {
	const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
		if (area === 'local' && key in changes) fn(changes[key].newValue as T | undefined);
	};
	try {
		browser.storage.onChanged.addListener(listener);
	} catch {
		// Without storage events the value is still read when a page starts.
		return () => {};
	}
	return () => browser.storage.onChanged.removeListener(listener);
}

/** The key under which the background caches settings from Gloss. */
export const SETTINGS_KEY = 'settings';

/** True inside a private window or incognito profile. */
export function inPrivateContext(): boolean {
	try {
		return Boolean(browser.extension?.inIncognitoContext);
	} catch {
		return false;
	}
}
