// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

// Reactive state of the in-page UI. The page state (asks and turns) is a
// plain object; `version` ticks whenever it changes so components that
// read it through `version` re-render.

import type { ConnectionStatus } from '../../shared/messages';
import { DEFAULT_SETTINGS } from '../../shared/protocol';
import { createPageState, type PageState } from '../state';

/** A viewport rectangle, copied out of a DOMRect so it survives in state. */
export interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

export function rectOf(r: DOMRect | DOMRectReadOnly): Rect {
	return {
		left: r.left,
		top: r.top,
		right: r.right,
		bottom: r.bottom,
		width: r.width,
		height: r.height
	};
}

export interface PillState {
	/** Viewport point the pill hangs from: the bottom-right of the selection. */
	x: number;
	y: number;
}

export type ComposerPhase = 'idle' | 'sending' | 'app_down' | 'launching';

export interface ComposerState {
	quote: string;
	/** Viewport rect of the selection the composer sits under. */
	rect: Rect;
	text: string;
	phase: ComposerPhase;
	error: string | null;
}

export interface PopoverState {
	askId: string;
}

export class UiStore {
	pill = $state<PillState | null>(null);
	composer = $state<ComposerState | null>(null);
	popover = $state<PopoverState | null>(null);
	/** Viewport rect of the open ask's glyph; null when the ask is an orphan. */
	anchorRect = $state<Rect | null>(null);
	connection = $state<ConnectionStatus>({ state: 'connecting', settings: DEFAULT_SETTINGS });
	toast = $state<string | null>(null);
	/** Viewport position of the note navigator; null while it is not shown. */
	dock = $state<{ left: number; top: number } | null>(null);
	/** The note the navigator last showed, where stepping continues from once its popover is closed. */
	lastAskId = $state<string | null>(null);
	version = $state(0);
	readonly page: PageState = createPageState();
	private toastTimer: ReturnType<typeof setTimeout> | null = null;

	/** Tells components that `page` changed. */
	bump(): void {
		this.version++;
	}

	showToast(message: string): void {
		this.toast = message;
		if (this.toastTimer) clearTimeout(this.toastTimer);
		this.toastTimer = setTimeout(() => (this.toast = null), 3500);
	}
}
