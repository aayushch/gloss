// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

// Messages between the background and the extension's own pages: content
// scripts, the toolbar popup and the ask window. All of them connect a
// runtime port and speak the same request/response/event shape. Safari
// clients also send a `BackgroundPing` before each request; see
// `shared/client.ts` for why.

import type { BridgeError, ExtensionSettings } from './protocol';

/** Port name every client connects with; the sender tells them apart. */
export const PORT_NAME = 'gloss';

/** How the background reaches Gloss right now, as the UI shows it. */
export interface ConnectionStatus {
	state:
		'connecting' | 'connected' | 'app_not_running' | 'host_missing' | 'protocol_mismatch' | 'error';
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
	/**
	 * The first message on every port. `instance` identifies the run of the
	 * background script that accepted the port; see `BackgroundPing`.
	 */
	| { type: 'welcome'; instance: string }
	| { type: 'response'; id: string; result?: unknown; error?: BridgeError }
	| { type: 'event'; event: string; data: unknown };

/**
 * Sent by a client with `runtime.sendMessage`, outside its port. Unlike a
 * port message, a one-shot runtime message starts the background script
 * when the browser has unloaded it. The background answers with
 * `BackgroundPingReply`.
 */
export interface BackgroundPing {
	type: 'background-ping';
}

export interface BackgroundPingReply {
	/**
	 * A random id the background script picks each time it starts. If it
	 * differs from the `instance` in the port's `welcome` message, the
	 * background that accepted the port has since been unloaded.
	 */
	instance: string;
}

/** Sent to a tab's content script with `tabs.sendMessage`; answered with a promise. */
export type TabMessage =
	| { type: 'focus-ask'; clarificationId: string }
	| { type: 'page-text' }
	| { type: 'ping' }
	/** Answered with `NavigatorState`. */
	| { type: 'navigator-state' }
	/** Puts back the note navigator the reader hid on this page. */
	| { type: 'show-navigator' }
	/**
	 * Open the composer for the page's current selection, asked for through
	 * the context menu or the keyboard shortcut. `selectionText` is the text
	 * the browser reported as selected (empty for the shortcut); the content
	 * script looks it up on the page when the live selection is unusable.
	 */
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
	openAskWindow: '$openAskWindow'
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
