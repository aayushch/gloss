// Messages between the background and the extension's own pages: content
// scripts, the toolbar popup and the ask window. All of them connect a
// runtime port and speak the same request/response/event shape.

import type { BridgeError, ExtensionSettings } from './protocol';

/** Port name every client connects with; the sender tells them apart. */
export const PORT_NAME = 'gloss';

/** How the background reaches Gloss right now, as the UI shows it. */
export interface ConnectionStatus {
	state: 'connecting' | 'connected' | 'app_not_running' | 'host_missing' | 'protocol_mismatch' | 'error';
	appVersion?: string;
	agent?: string;
	/** For `protocol_mismatch`: which side is too old. */
	mismatch?: 'update_app' | 'update_extension';
	message?: string;
	settings: ExtensionSettings;
}

/** Client → background. */
export type ClientMessage =
	| { type: 'request'; id: string; method: string; params?: unknown }
	| {
			/** Keys the background routes pushed events by, plus the badge count for tabs. */
			type: 'subscribe';
			urlKey: string | null;
			conversationId: string | null;
			askCount?: number;
	  };

/** Background → client. */
export type BackgroundMessage =
	| { type: 'response'; id: string; result?: unknown; error?: BridgeError }
	| { type: 'event'; event: string; data: unknown }
	| { type: 'open-composer'; selectionText: string };

/** Sent to a tab's content script with `tabs.sendMessage`; answered with a promise. */
export type TabMessage =
	| { type: 'focus-ask'; clarificationId: string }
	| { type: 'page-text' }
	| { type: 'ping' };

export interface PageTextReply {
	url: string;
	title: string;
	faviconUrl: string | null;
	text: string;
}

/** Methods the background answers itself instead of relaying to Gloss. */
export const LOCAL_METHODS = {
	status: '$status',
} as const;
