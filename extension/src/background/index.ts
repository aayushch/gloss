// The background: the one place that talks to Gloss. It greets Gloss with
// `hello`, relays requests from content scripts, the popup and the ask
// window, routes pushed events back to the clients they concern, keeps
// the toolbar badge and context menu, and launches Gloss on request.

import { browser, extensionVersion, SETTINGS_KEY, storageSet } from '../shared/browser';
import { LOCAL_METHODS, PORT_NAME, type AskWindowParams, type BackgroundMessage, type ClientMessage, type ConnectionStatus } from '../shared/messages';
import {
	BridgeFailure,
	DEFAULT_SETTINGS,
	failureOf,
	PROTOCOL,
	type AppStateEventData,
	type ExtensionSettings,
	type HelloResult,
	type PageEventData,
	type TurnEventEnvelope,
} from '../shared/protocol';
import type { TabMessage } from '../shared/messages';
import { NativePortTransport } from './native';
import { SafariTransport } from './safari';
import { ClientRegistry, type ClientEntry } from './tabs';
import type { Transport } from './transport';

const MENU_ID = 'gloss-ask';
const ASK_METHODS = new Set(['ask', 'askPage', 'followUp']);
/** Safari has no push: after launching Gloss the background greets it again on this schedule. */
const LAUNCH_PROBE_MS = 2_000;
const LAUNCH_PROBE_MAX_MS = 30_000;
/** Safari, while Gloss is away: how often the background checks whether it is back. */
const RECOVERY_PROBE_MS = 10_000;

const registry = new ClientRegistry();
const transport: Transport = __BROWSER__ === 'safari' ? new SafariTransport() : new NativePortTransport();
let status: ConnectionStatus = { state: 'connecting', settings: DEFAULT_SETTINGS };
let helloInFlight: Promise<void> | null = null;
let launchProbe: ReturnType<typeof setInterval> | null = null;
let recoveryProbe: ReturnType<typeof setInterval> | null = null;

function setStatus(next: Partial<ConnectionStatus> & { state: ConnectionStatus['state'] }): void {
	status = { settings: status.settings, ...next };
	registry.broadcast({ type: 'event', event: 'connection', data: status });
	if (!transport.pushesEvents) {
		if (status.state === 'app_not_running') startRecoveryProbe();
		else if (status.state === 'connected') stopRecoveryProbe();
	}
}

/**
 * Safari: nothing tells the background that Gloss started, so while the
 * status says it is away the background greets it every few seconds. Each
 * try is one native message that fails fast when Gloss is still away.
 */
function startRecoveryProbe(): void {
	if (recoveryProbe) return;
	recoveryProbe = setInterval(() => {
		if (isConnected()) {
			stopRecoveryProbe();
			return;
		}
		void hello().then(() => {
			if (isConnected()) registry.broadcast({ type: 'event', event: 'app_state', data: { running: true } satisfies AppStateEventData });
		});
	}, RECOVERY_PROBE_MS);
}

function stopRecoveryProbe(): void {
	if (recoveryProbe) clearInterval(recoveryProbe);
	recoveryProbe = null;
}

function setSettings(settings: ExtensionSettings): void {
	status = { ...status, settings };
	void storageSet(SETTINGS_KEY, settings);
	registry.broadcast({ type: 'event', event: 'settings', data: settings });
}

/** Greets Gloss; concurrent callers share one attempt. */
function hello(): Promise<void> {
	if (helloInFlight) return helloInFlight;
	helloInFlight = (async () => {
		try {
			const r = (await transport.request('hello', {
				protocol: PROTOCOL,
				extensionVersion: extensionVersion(),
				browser: __BROWSER__,
				userAgent: navigator.userAgent,
			})) as HelloResult;
			setStatus({ state: 'connected', appVersion: r.appVersion, agent: r.agent, settings: r.settings });
			void storageSet(SETTINGS_KEY, r.settings);
		} catch (e) {
			const f = failureOf(e);
			if (f.code === 'protocol') {
				setStatus({
					state: 'protocol_mismatch',
					mismatch: /update gloss/i.test(f.message) ? 'update_app' : 'update_extension',
					message: f.message,
				});
			} else if (f.code === 'app_not_running') {
				setStatus({ state: 'app_not_running', message: f.message });
			} else if (status.state !== 'host_missing') {
				setStatus({ state: 'error', message: f.message });
			}
		} finally {
			helloInFlight = null;
		}
	})();
	return helloInFlight;
}

/** Read through a function so callers see the status as it is after an await. */
function isConnected(): boolean {
	return status.state === 'connected';
}

/** The error a request gets while Gloss cannot be reached. */
function unavailable(): BridgeFailure {
	switch (status.state) {
		case 'protocol_mismatch':
			return new BridgeFailure('protocol', status.message ?? 'protocol mismatch');
		case 'host_missing':
			return new BridgeFailure('internal', 'The Gloss bridge is not installed. Open Gloss once to set it up.');
		case 'error':
			return new BridgeFailure('internal', status.message ?? 'cannot reach Gloss');
		default:
			return new BridgeFailure('app_not_running', 'Gloss is not running');
	}
}

/** Answers one client request, relaying to Gloss unless the background handles it itself. */
async function relay(client: ClientEntry, method: string, params: unknown): Promise<unknown> {
	if (method === LOCAL_METHODS.status) return status;
	if (method === LOCAL_METHODS.openAskWindow) {
		await openAskWindow(params as AskWindowParams);
		return { ok: true };
	}
	if (client.incognito && ASK_METHODS.has(method)) {
		throw new BridgeFailure('denied', 'Gloss does not take questions from private windows');
	}
	if (method === 'launchApp') {
		const r = await transport.request('launchApp', params);
		if (!transport.pushesEvents) startLaunchProbe();
		return r;
	}
	if (!isConnected()) {
		await hello();
		if (!isConnected()) throw unavailable();
	}
	try {
		return await transport.request(method, params);
	} catch (e) {
		const f = failureOf(e);
		if (f.code === 'protocol' && /hello/i.test(f.message)) {
			// The connection behind the transport was replaced; greet again and retry once.
			await hello();
			if (isConnected()) return await transport.request(method, params);
			throw unavailable();
		}
		if (f.code === 'app_not_running') setStatus({ state: 'app_not_running', message: f.message });
		throw f;
	}
}

/** Safari: greet every 2 s until Gloss answers, for up to 30 s after a launch. */
function startLaunchProbe(): void {
	if (launchProbe) return;
	const startedAt = Date.now();
	launchProbe = setInterval(async () => {
		await hello();
		if (isConnected()) {
			stopLaunchProbe();
			registry.broadcast({ type: 'event', event: 'app_state', data: { running: true } satisfies AppStateEventData });
		} else if (Date.now() - startedAt > LAUNCH_PROBE_MAX_MS) {
			stopLaunchProbe();
		}
	}, LAUNCH_PROBE_MS);
}

function stopLaunchProbe(): void {
	if (launchProbe) clearInterval(launchProbe);
	launchProbe = null;
}

// ---- events from Gloss ----------------------------------------------

transport.onEvent((event, data) => {
	switch (event) {
		case 'turn': {
			const env = data as TurnEventEnvelope;
			registry.send(registry.byConversation(env.conversationId), { type: 'event', event, data });
			break;
		}
		case 'page': {
			const p = data as PageEventData;
			registry.send(registry.byUrlKey(p.urlKey), { type: 'event', event, data });
			break;
		}
		case 'settings':
			setSettings(data as ExtensionSettings);
			break;
		case 'shutdown':
			setStatus({ state: 'app_not_running', message: 'Gloss quit' });
			registry.broadcast({ type: 'event', event: 'app_state', data: { running: false } satisfies AppStateEventData });
			break;
		case 'app_state': {
			const s = data as AppStateEventData;
			if (s.running) {
				void hello().then(() => registry.broadcast({ type: 'event', event: 'app_state', data: s }));
			} else {
				setStatus({ state: 'app_not_running', message: 'Gloss is not running' });
				registry.broadcast({ type: 'event', event: 'app_state', data: s });
			}
			break;
		}
	}
});

transport.onStateChange((state, detail) => {
	if (state === 'connected') {
		void hello();
	} else if (state === 'disconnected') {
		const missing = /not found|no such native|host/i.test(detail ?? '');
		setStatus({ state: missing ? 'host_missing' : 'app_not_running', message: detail });
	}
});

// ---- clients ----------------------------------------------------------

function setBadge(tabId: number, count: number): void {
	try {
		void browser.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' });
	} catch {
		// Badges are cosmetic; a browser without per-tab badges is fine.
	}
}

browser.runtime.onConnect.addListener((port) => {
	if (port.name !== PORT_NAME) return;
	const sender = port.sender;
	const tab = sender?.tab;
	const extensionOrigin = browser.runtime.getURL('');
	const entry: ClientEntry = {
		port,
		tabId: tab?.id ?? null,
		incognito: Boolean(tab?.incognito),
		isContent: tab?.id !== undefined && !(sender?.url ?? '').startsWith(extensionOrigin),
		urlKey: null,
		conversationId: null,
	};
	registry.add(entry);
	// A transport without pushes (Safari) learns that Gloss came back only by
	// asking, so a page opening while the status says "not running" is the
	// moment to greet again; the other transports reconnect on their own.
	if (!transport.pushesEvents && !isConnected() && !helloInFlight) void hello();
	port.onMessage.addListener((raw: ClientMessage) => {
		if (raw.type === 'subscribe') {
			entry.urlKey = raw.urlKey;
			entry.conversationId = raw.conversationId;
			if (entry.isContent && entry.tabId !== null && raw.askCount !== undefined) setBadge(entry.tabId, raw.askCount);
			return;
		}
		if (raw.type !== 'request') return;
		relay(entry, raw.method, raw.params)
			.then((result) => port.postMessage({ type: 'response', id: raw.id, result } satisfies BackgroundMessage))
			.catch((e) => {
				const f = failureOf(e);
				port.postMessage({ type: 'response', id: raw.id, error: { code: f.code, message: f.message } } satisfies BackgroundMessage);
			});
	});
	port.onDisconnect.addListener(() => registry.remove(entry));
	port.postMessage({ type: 'event', event: 'connection', data: status } satisfies BackgroundMessage);
});

// ---- context menu and keyboard command ---------------------------------

async function setupMenu(): Promise<void> {
	try {
		await browser.contextMenus.removeAll();
		browser.contextMenus.create({ id: MENU_ID, title: 'Ask Gloss about “%s”', contexts: ['selection'] });
	} catch (e) {
		console.warn('gloss: context menu unavailable', e);
	}
}

/** How long the tab's content script gets to take an ask before the ask window opens instead. */
const CONTENT_REPLY_MS = 500;

/**
 * Opens the composer in the tab, or the standalone ask window when the
 * tab's document has no content script (the PDF viewer, browser pages).
 * The tab itself is asked, since the connected ports are no guide: a page
 * parked in the back-forward cache keeps its port while the tab shows
 * something else.
 */
async function askFromTab(tab: chrome.tabs.Tab | undefined, selectionText: string): Promise<void> {
	if (!tab?.id) {
		const [active] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
		tab = active;
	}
	if (!tab?.id) return;
	const opened = await Promise.race([
		browser.tabs.sendMessage(tab.id, { type: 'open-composer', selectionText } satisfies TabMessage).then(() => true, () => false),
		new Promise<boolean>((r) => setTimeout(() => r(false), CONTENT_REPLY_MS)),
	]);
	if (opened || tab.incognito) return;
	await openAskWindow({ url: tab.url ?? '', title: tab.title ?? '', text: selectionText });
}

/** The ask window's tab while one is open, so the next ask loads into it where the reader left it. */
let askWindowTab: number | null = null;

async function openAskWindow(p: AskWindowParams): Promise<void> {
	const query = new URLSearchParams({ url: p.url, title: p.title });
	if (p.text) query.set('text', p.text);
	if (p.focus) query.set('focus', p.focus);
	const url = browser.runtime.getURL('ask.html') + '?' + query.toString();
	if (askWindowTab !== null) {
		try {
			// A tab opened in place of a window may since have been navigated elsewhere; that tab is left alone.
			const current = await browser.tabs.get(askWindowTab);
			if (!current.url?.startsWith(browser.runtime.getURL('ask.html'))) throw new Error('not the ask window');
			const t = await browser.tabs.update(askWindowTab, { url });
			if (t?.windowId !== undefined) await browser.windows.update(t.windowId, { focused: true });
			return;
		} catch {
			// The window was closed or its tab shows something else now; open a new one.
			askWindowTab = null;
		}
	}
	try {
		const w = await browser.windows.create({ url, type: 'popup', width: 420, height: 560 });
		askWindowTab = w?.tabs?.[0]?.id ?? null;
	} catch (e) {
		console.warn('gloss: could not open the ask window, opening a tab instead', e);
		const t = await browser.tabs.create({ url });
		askWindowTab = t.id ?? null;
	}
}

browser.tabs.onRemoved.addListener((tabId) => {
	if (tabId === askWindowTab) askWindowTab = null;
});

browser.runtime.onInstalled.addListener(() => void setupMenu());
browser.runtime.onStartup?.addListener(() => void setupMenu());
browser.contextMenus.onClicked.addListener((info, tab) => {
	if (info.menuItemId === MENU_ID) void askFromTab(tab, info.selectionText ?? '');
});
browser.commands?.onCommand.addListener((command, tab) => {
	if (command === 'ask-selection') void askFromTab(tab, '');
});

// ---- startup -----------------------------------------------------------

try {
	void browser.action.setBadgeBackgroundColor({ color: '#c2410c' });
} catch {
	// Not every browser lets the badge colour be set.
}
try {
	// Content scripts read the cached settings from session storage.
	const session = browser.storage.session as { setAccessLevel?: (o: { accessLevel: string }) => Promise<void> } | undefined;
	void session?.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
} catch {
	// Older browsers keep session storage private to the background; content scripts then start unrestricted.
}
transport.connect();
void hello();
