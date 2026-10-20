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
export type BackgroundMessage = { type: 'response'; id: string; result?: unknown; error?: BridgeError } | { type: 'event'; event: string; data: unknown };

/** Sent to a tab's content script with `tabs.sendMessage`; answered with a promise. */
export type TabMessage =
	| { type: 'focus-ask'; clarificationId: string }
	| { type: 'page-text' }
	| { type: 'ping' }
	/** Answered with `NavigatorState`. */
	| { type: 'navigator-state' }
	/** Puts back the note navigator the reader hid on this page. */
	| { type: 'show-navigator' }
	/** Open the composer for the page's current selection. */
	| { type: 'open-composer'; selectionText: string };

/** Whether the page's note navigator is showing, for the toolbar popup. */
export interface NavigatorState {
	/** The reader hid it with its ×. */
	hidden: boolean;
	/** Notes on the page; the navigator shows only when there is at least one. */
	notes: number;
}

export interface PageTextReply {
	url: string;
	title: string;
	faviconUrl: string | null;
	text: string;
}

/** Methods the background answers itself instead of relaying to Gloss. */
export const LOCAL_METHODS = {
	status: '$status',
	/** Opens the ask window with `AskWindowParams`, reusing the one already open. */
	openAskWindow: '$openAskWindow',
} as const;

/**
 * What the ask window shows, passed in its URL. `text` is a selection to
 * ask about; `focus` is the id of an existing note to show first. Without
 * either it opens on a question about the whole page.
 */
export interface AskWindowParams {
	url: string;
	title: string;
	text?: string;
	focus?: string;
}
