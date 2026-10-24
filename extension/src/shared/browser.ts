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
