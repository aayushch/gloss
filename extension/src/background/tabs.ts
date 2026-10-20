// The registry of connected clients: every content script, popup and ask
// window holds a port here with the keys pushed events are routed by.

import type { BackgroundMessage } from '../shared/messages';

export interface ClientEntry {
	port: chrome.runtime.Port;
	tabId: number | null;
	/** True for ports from private windows; their asks are refused. */
	incognito: boolean;
	/** Content scripts only; popups and ask windows have no tab of their own. */
	isContent: boolean;
	urlKey: string | null;
	conversationId: string | null;
}

export class ClientRegistry {
	private readonly clients = new Set<ClientEntry>();

	add(entry: ClientEntry): void {
		this.clients.add(entry);
	}

	remove(entry: ClientEntry): void {
		this.clients.delete(entry);
	}

	all(): ClientEntry[] {
		return [...this.clients];
	}

	/** The content script of a tab, when one is connected. */
	contentOfTab(tabId: number): ClientEntry | undefined {
		for (const c of this.clients) if (c.isContent && c.tabId === tabId) return c;
		return undefined;
	}

	byUrlKey(urlKey: string): ClientEntry[] {
		return this.all().filter((c) => c.urlKey === urlKey);
	}

	byConversation(conversationId: string): ClientEntry[] {
		return this.all().filter((c) => c.conversationId === conversationId);
	}

	/** Sends a message to each entry, dropping entries whose port is gone. */
	send(entries: Iterable<ClientEntry>, msg: BackgroundMessage): void {
		for (const c of entries) {
			try {
				c.port.postMessage(msg);
			} catch {
				this.clients.delete(c);
			}
		}
	}

	broadcast(msg: BackgroundMessage): void {
		this.send(this.clients, msg);
	}
}
