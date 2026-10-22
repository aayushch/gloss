// The content script: shows the "Ask about this" pill on a selection, the
// composer, the glyphs and the reply popover; anchors every ask of the
// page on load and keeps it anchored as the page changes. It talks to
// Gloss only through the background.

import { mount, unmount } from 'svelte';
import { browser, inPrivateContext, localGet, localSet, SETTINGS_KEY, storageGet } from '../shared/browser';
import { connectClient, type Client } from '../shared/client';
import type { BackgroundMessage, ConnectionStatus, NavigatorState, PageTextReply, TabMessage } from '../shared/messages';
import {
	DEFAULT_SETTINGS,
	BridgeFailure,
	failureOf,
	isDeniedHost,
	type AnchorState,
	type AppStateEventData,
	type AskContext,
	type ExtensionSettings,
	type FollowUpResult,
	type GetPageResult,
	type PageAskRequest,
	type PageAskResult,
	type PageEventData,
	type TurnEventEnvelope,
	type WebAnchor,
} from '../shared/protocol';
import { describe, resolve } from './anchor';
import { Dock, fractionOf } from './dock';
import { GUARD_KEY, GUARDED_EVENTS, guardListening, type GuardHolder } from './events';
import { UiGuard } from './uiguard';
import { GlyphLayer } from './glyphs';
import { HighlightLayer } from './highlight';
import { addAsk, addFollowUp, applyTurnEvent, clearPage, loadPage, orderedAskIds, removeAsk, setAnchor, setOpen, type AskAnchorState, type AskEntry } from './state';
import { passageY, scrollToSpot, spotOf } from './spot';
import styles from './styles.css';
import { HOST_TAG, normalise, TextIndex } from './text';
import type { Actions } from './ui/actions';
import App from './ui/App.svelte';
import { rectOf, UiStore } from './ui/store.svelte';
import { watchUrl } from './urlwatch';

/** Shortest selection the pill appears for. */
const MIN_SELECTION_CHARS = 3;
/** Characters of page text sent around the quote. */
const CONTEXT_CHARS = 300;
/** Page text sent with an ask is cut to the first 40k and last 20k characters. */
const PAGE_TEXT_HEAD = 40_000;
const PAGE_TEXT_TAIL = 20_000;
/** Orphans are tried again on this schedule after load: pages often render late. */
const ORPHAN_RETRY_MS = [1_000, 2_000, 3_000];
/**
 * Asks whose passage is not on the page are looked for again once the page
 * has stopped changing for this long, and at least this often while it
 * keeps changing (a log that streams in never stops).
 */
const MISSING_SETTLE_MS = 400;
const MISSING_MAX_WAIT_MS = 2_000;
/** After the navigator scrolls to a detached passage, it is looked for on this schedule while the page renders it. */
const SCROLL_BACK_RETRY_MS = [100, 400, 1_000];
/** Local storage key of the navigator's height on the right edge, a fraction of the viewport height. */
const NAV_HEIGHT_KEY = 'navigatorHeight';
/** How long the composer waits for Gloss to come up after "Open Gloss". */
const LAUNCH_WAIT_MS = 45_000;

interface PendingAsk {
	anchor: WebAnchor;
	range: Range;
	context: AskContext;
}

class ContentApp {
	private readonly store = new UiStore();
	private client!: Client;
	private host!: HTMLElement;
	private shadow!: ShadowRoot;
	private app: ReturnType<typeof mount> | null = null;
	private highlights!: HighlightLayer;
	private glyphs!: GlyphLayer;
	private dock!: Dock;
	/** The reader hid the note navigator; it comes back with the next ask or page load. */
	private navigatorHidden = false;
	private index: TextIndex | null = null;
	private indexDirty = true;
	private mutations: MutationObserver | null = null;
	private pending: PendingAsk | null = null;
	/** The selection the pill was last shown for, kept for `askRange`. */
	private pillRange: Range | null = null;
	private launchTimer: ReturnType<typeof setTimeout> | null = null;
	private loading: Promise<void> | null = null;
	private retryTimers: ReturnType<typeof setTimeout>[] = [];
	private reresolveTimer: ReturnType<typeof setTimeout> | null = null;
	private missingTimer: ReturnType<typeof setTimeout> | null = null;
	/** When the pending `missingTimer` was first set, for `MISSING_MAX_WAIT_MS`. */
	private missingSince = 0;
	private scrollBackTimers: ReturnType<typeof setTimeout>[] = [];
	private readonly reresolveIds = new Set<string>();
	private stopUrlWatch: (() => void) | null = null;
	private disposed = false;
	private uiGuard!: UiGuard;
	private readonly listeners: [EventTarget, string, EventListener, AddEventListenerOptions | boolean | undefined][] = [];

	constructor(private settings: ExtensionSettings) {}

	start(): void {
		this.host = document.createElement(HOST_TAG);
		// react-focus-lock (Atlassian, many React apps) leaves focus alone
		// inside an element carrying this attribute; `UiGuard` (uiguard.ts)
		// handles every other focus trap.
		this.host.setAttribute('data-no-focus-lock', '');
		this.shadow = this.host.attachShadow({ mode: 'closed' });
		const style = document.createElement('style');
		style.textContent = styles;
		this.shadow.appendChild(style);
		const highlightRoot = document.createElement('div');
		highlightRoot.className = 'gloss-hls';
		this.shadow.appendChild(highlightRoot);
		const glyphRoot = document.createElement('div');
		glyphRoot.className = 'gloss-glyphs';
		this.shadow.appendChild(glyphRoot);
		const uiRoot = document.createElement('div');
		this.shadow.appendChild(uiRoot);
		document.documentElement.appendChild(this.host);

		this.highlights = new HighlightLayer(highlightRoot);
		this.glyphs = new GlyphLayer(glyphRoot, {
			onClick: (id) => this.togglePopover(id),
			onDetached: (id) => this.queueReresolve(id),
			onReposition: () => {
				this.highlights.repaint();
				this.updateAnchorRect();
				this.refreshSpots();
			},
		});
		this.dock = new Dock(
			(x, y) => {
				for (const el of document.elementsFromPoint(x, y)) if (el !== this.host) return el;
				return null;
			},
			(pos) => (this.store.dock = { left: pos.left, top: pos.top }),
			() => !!this.shadow.querySelector('.gloss-nav:hover, .gloss-nav:focus-within, .gloss-nav.is-dragging'),
		);
		void localGet<number>(NAV_HEIGHT_KEY).then((f) => {
			if (typeof f === 'number' && !this.disposed) this.dock.setFraction(f);
		});
		this.mutations = new MutationObserver(() => {
			this.indexDirty = true;
			this.scheduleMissingRetry();
		});
		this.mutations.observe(document.body, { childList: true, subtree: true, characterData: true });

		this.app = mount(App, { target: uiRoot, props: { store: this.store, actions: this.actions() } });

		this.client = connectClient();
		this.client.onEvent((event, data) => this.onEvent(event, data));
		// A page the browser parks in its back-forward cache keeps running
		// scripts' ports open, so the background would still count it as
		// the tab's page; the port is let go while the page is parked.
		this.listen(window, 'pagehide', (e) => {
			if ((e as PageTransitionEvent).persisted) this.client.suspend();
		});
		this.listen(window, 'pageshow', (e) => {
			if ((e as PageTransitionEvent).persisted) this.client.resume();
		});

		// guard.ts, run before the page's scripts, holds the first window
		// listeners and calls this guard from them. Where those listeners
		// are missing (an extension reload leaves open pages without
		// guard.ts, and a page's `document.open()` erases them), the guard
		// listens itself, after whatever the page added before it;
		// pageguard.ts keeps the page's own listeners out either way.
		this.uiGuard = new UiGuard(this.host, this.shadow, (e) => this.onDocumentKeyDown(e));
		if (guardListening()) (globalThis as GuardHolder)[GUARD_KEY] = this.uiGuard.handle;
		else for (const type of GUARDED_EVENTS) this.listen(window, type, this.uiGuard.handle, true);
		this.listen(document, 'mouseup', () => this.scheduleSelectionCheck());
		this.listen(document, 'keyup', () => this.scheduleSelectionCheck());
		this.listen(document, 'selectionchange', () => this.onSelectionChange());
		this.listen(document, 'mousedown', (e) => this.onDocumentMouseDown(e as MouseEvent), true);
		this.listen(document, 'keydown', (e) => this.onDocumentKeyDown(e as KeyboardEvent), true);
		this.listen(document, 'click', (e) => this.onDocumentClick(e as MouseEvent), true);
		if (__BROWSER__ === 'safari') {
			this.listen(document, 'visibilitychange', () => {
				if (document.visibilityState === 'visible') void this.loadPage();
			});
		}
		this.stopUrlWatch = watchUrl(() => this.onUrlChange());
		browser.runtime.onMessage.addListener(this.onTabMessage);

		void this.loadPage();
	}

	/**
	 * False once the page has taken the Gloss UI out of the document. A
	 * page's `document.open()` does that and also erases every listener
	 * the UI added, so `main` then starts the UI again from scratch.
	 */
	get onPage(): boolean {
		return this.disposed || this.host.isConnected;
	}

	private listen(target: EventTarget, type: string, fn: EventListener, options?: AddEventListenerOptions | boolean): void {
		target.addEventListener(type, fn, options);
		this.listeners.push([target, type, fn, options]);
	}

	/** Takes everything off the page, for deny-listed hosts. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const [t, type, fn, options] of this.listeners) t.removeEventListener(type, fn, options);
		browser.runtime.onMessage.removeListener(this.onTabMessage);
		const holder = globalThis as GuardHolder;
		if (holder[GUARD_KEY] === this.uiGuard.handle) delete holder[GUARD_KEY];
		this.stopUrlWatch?.();
		this.mutations?.disconnect();
		for (const t of this.retryTimers) clearTimeout(t);
		if (this.reresolveTimer) clearTimeout(this.reresolveTimer);
		if (this.missingTimer) clearTimeout(this.missingTimer);
		for (const t of this.scrollBackTimers) clearTimeout(t);
		if (this.launchTimer) clearTimeout(this.launchTimer);
		this.dock.hide();
		this.glyphs.dispose();
		this.highlights.dispose();
		if (this.app) void unmount(this.app);
		this.host.remove();
		this.client.close();
	}

	/** Tells the UI the page state changed and shows or hides the note navigator to match. */
	private bump(): void {
		this.store.bump();
		const { lastAskId } = this.store;
		if (lastAskId && !this.store.page.asks.has(lastAskId)) this.store.lastAskId = null;
		if (!this.disposed && this.store.page.asks.size > 0 && !this.navigatorHidden) {
			this.dock.show();
		} else {
			this.dock.hide();
			this.store.dock = null;
		}
	}

	// ---- page loading and anchoring ----------------------------------

	private pageMeta() {
		return { url: location.href, title: document.title, faviconUrl: faviconUrl() };
	}

	/** The text index, rebuilt after DOM changes. */
	private textIndex(): TextIndex {
		if (!this.index || this.indexDirty) {
			this.index = TextIndex.ofDocument(document);
			this.indexDirty = false;
		}
		return this.index;
	}

	/** Fetches the page from Gloss and anchors its asks; concurrent calls share one fetch. */
	private loadPage(): Promise<void> {
		if (this.loading) return this.loading;
		this.loading = (async () => {
			let result: GetPageResult;
			try {
				result = await this.client.request<GetPageResult>('getPage', this.pageMeta());
			} catch (e) {
				const f = failureOf(e);
				if (f.code !== 'app_not_running' && f.code !== 'internal' && f.code !== 'protocol') console.warn('gloss: getPage failed', f.message);
				return;
			}
			if (this.disposed) return;
			const removed = new Set(this.store.page.asks.keys());
			loadPage(this.store.page, result);
			for (const id of this.store.page.asks.keys()) removed.delete(id);
			for (const id of removed) this.forgetAsk(id);
			this.subscribe();
			this.bump();
			this.resolvePending();
			this.scheduleOrphanRetries();
		})().finally(() => (this.loading = null));
		return this.loading;
	}

	private subscribe(): void {
		const page = this.store.page;
		this.client.subscribe({ urlKey: page.urlKey, conversationId: page.conversationId, askCount: page.asks.size });
	}

	/** Resolves every ask that has no anchor yet and reports the states to Gloss. */
	private resolvePending(): void {
		const states: Record<string, AskAnchorState> = {};
		for (const [id, entry] of this.store.page.asks) {
			if (entry.state !== 'pending') continue;
			this.resolveOne(id, entry);
			states[id] = entry.state;
		}
		this.report(states);
		this.bump();
	}

	/**
	 * Resolves one ask against the current index and updates its highlight
	 * and glyph. An ask not found becomes `detached` when its passage was
	 * found earlier on this visit (the page removed its text, as pages that
	 * render only what is on screen do), else an orphan. `approximate`
	 * false skips the costly approximate search (see `resolve`).
	 */
	private resolveOne(id: string, entry: AskEntry, approximate = true): void {
		const anchor = entry.clarification.webAnchor;
		if (!anchor) return;
		const index = this.textIndex();
		const found = resolve(anchor, index, approximate);
		if (entry.range) this.highlights.remove(entry.range);
		if (!found) {
			const seen = entry.state === 'anchored' || entry.state === 'fuzzy' || entry.state === 'detached';
			setAnchor(this.store.page, id, null, seen ? 'detached' : 'orphan');
			this.glyphs.remove(id);
			if (this.store.popover?.askId === id) this.store.anchorRect = null;
			return;
		}
		setAnchor(this.store.page, id, found.range, found.state);
		entry.spot = spotOf(found.range, entry.spot) ?? entry.spot;
		this.highlights.add(found.range);
		this.glyphs.set(id, found.range, {
			open: entry.clarification.open,
			active: this.store.popover?.askId === id,
			fuzzy: found.state === 'fuzzy',
		});
		if (this.store.popover?.askId === id) {
			this.highlights.setActive(found.range);
			this.updateAnchorRect();
		}
	}

	/** Tells Gloss the anchor states found; `detached` and `pending` stay on this page. */
	private report(all: Record<string, AskAnchorState>): void {
		const states: Record<string, AnchorState> = {};
		for (const [id, state] of Object.entries(all)) if (state !== 'detached' && state !== 'pending') states[id] = state;
		if (!Object.keys(states).length) return;
		this.client.request('reportAnchors', { states }).catch(() => {});
	}

	/** Records where each passage on the page sits, as it may scroll away and be removed. */
	private refreshSpots(): void {
		for (const entry of this.store.page.asks.values()) {
			const range = entry.range;
			if (!range || (entry.state !== 'anchored' && entry.state !== 'fuzzy') || !document.contains(range.startContainer)) continue;
			entry.spot = spotOf(range, entry.spot) ?? entry.spot;
		}
	}

	private hasMissing(): boolean {
		for (const entry of this.store.page.asks.values()) if (entry.state === 'orphan' || entry.state === 'detached') return true;
		return false;
	}

	/** The page changed: looks for missing passages again once it settles (see `MISSING_SETTLE_MS`). */
	private scheduleMissingRetry(): void {
		if (this.disposed || !this.hasMissing()) return;
		if (this.missingTimer) {
			if (Date.now() - this.missingSince >= MISSING_MAX_WAIT_MS) return;
			clearTimeout(this.missingTimer);
		} else {
			this.missingSince = Date.now();
		}
		this.missingTimer = setTimeout(() => {
			this.missingTimer = null;
			this.retryMissing();
		}, MISSING_SETTLE_MS);
	}

	/** Looks for every orphan and detached passage again, with the exact stages only. */
	private retryMissing(): void {
		if (this.disposed) return;
		const states: Record<string, AskAnchorState> = {};
		for (const [id, entry] of this.store.page.asks) {
			if (entry.state !== 'orphan' && entry.state !== 'detached') continue;
			const before = entry.state;
			this.resolveOne(id, entry, false);
			if (entry.state !== before) states[id] = entry.state;
		}
		if (!Object.keys(states).length) return;
		this.report(states);
		this.bump();
	}

	/** Tries orphans again at 1 s, 3 s and 6 s after a load. */
	private scheduleOrphanRetries(): void {
		for (const t of this.retryTimers) clearTimeout(t);
		this.retryTimers = [];
		let delay = 0;
		for (const step of ORPHAN_RETRY_MS) {
			delay += step;
			this.retryTimers.push(
				setTimeout(() => {
					if (this.disposed) return;
					const states: Record<string, AskAnchorState> = {};
					for (const [id, entry] of this.store.page.asks) {
						if (entry.state !== 'orphan') continue;
						this.resolveOne(id, entry);
						if (entry.state !== 'orphan') states[id] = entry.state;
					}
					this.report(states);
					this.bump();
				}, delay),
			);
		}
	}

	/** An ask's range died with a DOM change; resolve it again shortly. */
	private queueReresolve(id: string): void {
		this.reresolveIds.add(id);
		if (this.reresolveTimer) return;
		this.reresolveTimer = setTimeout(() => {
			this.reresolveTimer = null;
			const ids = [...this.reresolveIds];
			this.reresolveIds.clear();
			const states: Record<string, AskAnchorState> = {};
			for (const id of ids) {
				const entry = this.store.page.asks.get(id);
				if (!entry) continue;
				const before = entry.state;
				this.resolveOne(id, entry);
				if (entry.state !== before) states[id] = entry.state;
			}
			this.report(states);
			this.bump();
		}, 300);
	}

	private forgetAsk(id: string): void {
		const entry = this.store.page.asks.get(id);
		if (entry?.range) this.highlights.remove(entry.range);
		this.glyphs.remove(id);
		if (this.store.popover?.askId === id) this.closePopover();
	}

	private onUrlChange(): void {
		this.store.pill = null;
		this.closePopover();
		this.cancelComposer();
		this.store.lastAskId = null;
		this.navigatorHidden = false;
		this.highlights.clear();
		this.glyphs.clear();
		this.indexDirty = true;
		for (const [id, entry] of this.store.page.asks) {
			setAnchor(this.store.page, id, null, 'pending');
			entry.spot = null;
		}
		void this.loadPage();
	}

	/** The page text sent with an ask: the article or main element when there is one, else the body. */
	private pageText(): string {
		const readable = document.querySelector('article, main');
		const index = readable ? new TextIndex(readable) : this.textIndex();
		const text = index.text;
		if (text.length <= PAGE_TEXT_HEAD + PAGE_TEXT_TAIL) return text;
		return text.slice(0, PAGE_TEXT_HEAD) + '\n…\n' + text.slice(-PAGE_TEXT_TAIL);
	}

	// ---- selection and pill ---------------------------------------------

	private scheduleSelectionCheck(): void {
		setTimeout(() => this.checkSelection(), 0);
	}

	private selectedRange(): Range | null {
		const sel = document.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
		const range = sel.getRangeAt(0);
		if (range.collapsed) return null;
		const node = range.commonAncestorContainer;
		if (node.getRootNode() !== document) return null;
		if (this.host.contains(node)) return null;
		if (isEditable(node)) return null;
		if (normalise(range.toString()).length < MIN_SELECTION_CHARS) return null;
		return range;
	}

	private checkSelection(): void {
		if (this.disposed || this.store.composer) return;
		const range = this.selectedRange();
		if (!range) {
			this.store.pill = null;
			return;
		}
		const rect = lastRect(range);
		if (!rect) {
			this.store.pill = null;
			return;
		}
		this.pillRange = range.cloneRange();
		this.store.pill = { x: rect.right, y: rect.bottom };
	}

	/**
	 * The passage an ask is about: the live selection, or else the one the
	 * pill was shown for. Safari drops the page selection when the pill is
	 * pressed, before the press is handled, so the copy taken when the pill
	 * appeared is what the composer then opens on.
	 */
	private askRange(): Range | null {
		const live = this.selectedRange();
		if (live) return live;
		const kept = this.pillRange;
		if (!kept || kept.collapsed || !document.contains(kept.commonAncestorContainer)) return null;
		return kept;
	}

	private onSelectionChange(): void {
		if (this.store.pill && !this.store.composer) {
			const sel = document.getSelection();
			if (!sel || sel.isCollapsed) this.store.pill = null;
		}
	}

	private onDocumentMouseDown(e: MouseEvent): void {
		if (e.composedPath().includes(this.host)) return;
		this.store.pill = null;
		if (this.store.composer && !this.store.composer.text.trim() && this.store.composer.phase === 'idle') this.cancelComposer();
	}

	private onDocumentKeyDown(e: KeyboardEvent): void {
		if (e.key !== 'Escape') return;
		if (this.store.composer) this.cancelComposer();
		else if (this.store.popover) this.closePopover();
		else if (this.store.pill) this.store.pill = null;
	}

	// ---- composer ------------------------------------------------------------

	/** Opens the composer for the current selection; shows a toast when there is none. */
	private openComposer(): void {
		const range = this.askRange();
		if (!range) {
			this.store.showToast('Select some text on the page first.');
			return;
		}
		const index = this.textIndex();
		const anchor = describe(range, index);
		if (!anchor || !anchor.position) {
			this.store.showToast('That selection has no page text Gloss can anchor to.');
			return;
		}
		const { start, end } = anchor.position;
		const captured = range.cloneRange();
		this.pending = {
			anchor,
			range: captured,
			context: {
				before: index.text.slice(Math.max(0, start - CONTEXT_CHARS), start),
				after: index.text.slice(end, end + CONTEXT_CHARS),
			},
		};
		const rect = lastRect(captured) ?? captured.getBoundingClientRect();
		this.store.pill = null;
		this.closePopover();
		this.highlights.setActive(captured);
		this.store.composer = { quote: anchor.quote.exact, rect: rectOf(rect), text: '', phase: 'idle', error: null };
	}

	private cancelComposer(): void {
		if (!this.store.composer) return;
		this.store.composer = null;
		this.pending = null;
		this.highlights.setActive(null);
		if (this.launchTimer) clearTimeout(this.launchTimer);
		this.launchTimer = null;
	}

	private async send(text: string): Promise<void> {
		const composer = this.store.composer;
		const pending = this.pending;
		if (!composer || !pending) return;
		composer.text = text;
		composer.phase = 'sending';
		composer.error = null;
		const payload: PageAskRequest = {
			page: this.pageMeta(),
			anchor: pending.anchor,
			context: pending.context,
			question: text,
			pageText: this.settings.sendPageText ? this.pageText() : null,
			private: inPrivateContext(),
		};
		try {
			const result = await this.client.request<PageAskResult>('ask', payload);
			if (this.store.composer !== composer) return;
			const entry = addAsk(this.store.page, result, pending.range, 'anchored');
			this.store.composer = null;
			this.pending = null;
			this.highlights.setActive(null);
			if (entry && result.clarification) {
				this.navigatorHidden = false;
				this.highlights.add(pending.range);
				this.glyphs.set(result.clarification.id, pending.range, { open: true, active: false, fuzzy: false });
				this.openPopover(result.clarification.id);
			}
			this.subscribe();
			this.bump();
		} catch (e) {
			if (this.store.composer !== composer) return;
			const f = failureOf(e);
			if (f.code === 'app_not_running') {
				composer.phase = 'app_down';
				composer.error = appDownReason(f);
			} else {
				composer.phase = 'idle';
				composer.error =
					f.code === 'busy'
						? 'Gloss is still answering another question on this page.'
						: f.code === 'denied'
							? 'Gloss is set not to take questions from this site.'
							: f.message;
			}
		}
	}

	/** "Open Gloss" in the composer: launches the app and sends the kept text once it is up. */
	private launchApp(): void {
		const composer = this.store.composer;
		if (!composer) return;
		composer.phase = 'launching';
		composer.error = null;
		this.client.request('launchApp', {}).catch((e) => {
			if (this.store.composer !== composer) return;
			composer.phase = 'app_down';
			composer.error = failureOf(e).message;
		});
		if (this.launchTimer) clearTimeout(this.launchTimer);
		this.launchTimer = setTimeout(() => {
			if (this.store.composer === composer && composer.phase === 'launching') {
				composer.phase = 'app_down';
				composer.error = "Gloss didn't start. Open it by hand and try again.";
			}
		}, LAUNCH_WAIT_MS);
	}

	// ---- popover ----------------------------------------------------------------

	private togglePopover(id: string): void {
		if (this.store.popover?.askId === id) this.closePopover();
		else this.openPopover(id);
	}

	private openPopover(id: string): void {
		const entry = this.store.page.asks.get(id);
		if (!entry) return;
		if (this.store.popover && this.store.popover.askId !== id) this.closePopover();
		this.cancelComposer();
		this.store.pill = null;
		this.store.popover = { askId: id };
		this.store.lastAskId = id;
		this.highlights.setActive(entry.range);
		this.glyphs.update(id, { active: true });
		this.updateAnchorRect();
		if (!entry.clarification.open) {
			setOpen(this.store.page, id, true);
			this.glyphs.update(id, { open: true });
			this.bump();
			this.client.request('setOpen', { clarificationId: id, open: true }).catch(() => {});
		}
	}

	private closePopover(): void {
		const open = this.store.popover;
		if (!open) return;
		this.store.popover = null;
		this.store.anchorRect = null;
		this.highlights.setActive(null);
		this.glyphs.update(open.askId, { active: false });
	}

	/**
	 * Shows a note and opens its popover. A passage on the page is scrolled
	 * into view and the popover hangs from it. A detached passage's last
	 * spot is scrolled into view and looked for while the page renders it
	 * again; the popover sits at the top of the viewport until it is found,
	 * then moves beside it. An orphan's popover stays at the top.
	 */
	private focusAsk(id: string, warnOrphan: boolean): boolean {
		const entry = this.store.page.asks.get(id);
		if (!entry) return false;
		if (entry.range && (entry.state === 'anchored' || entry.state === 'fuzzy')) {
			this.glyphs.scrollTo(id);
		} else if (entry.state === 'detached' && entry.spot && scrollToSpot(entry.spot)) {
			// The page puts the passage back once its spot is on screen.
			for (const t of this.scrollBackTimers) clearTimeout(t);
			this.scrollBackTimers = SCROLL_BACK_RETRY_MS.map((ms) => setTimeout(() => this.retryMissing(), ms));
		} else if (warnOrphan) {
			this.store.showToast("This note's passage is no longer on the page.");
		}
		this.openPopover(id);
		// The popover follows the passage while a smooth scroll runs; this
		// catches the final position when the scroll fired no events.
		setTimeout(() => this.updateAnchorRect(), 400);
		return true;
	}

	/** Shows the note `delta` places from the current one in reading order, wrapping at either end. */
	private stepNote(delta: 1 | -1): void {
		const ids = orderedAskIds(this.store.page, passageY);
		if (!ids.length) return;
		const current = this.store.popover?.askId ?? this.store.lastAskId;
		const i = current ? ids.indexOf(current) : -1;
		const next = i < 0 ? (delta > 0 ? 0 : ids.length - 1) : (i + delta + ids.length) % ids.length;
		this.focusAsk(ids[next], false);
	}

	private toggleNote(): void {
		if (this.store.popover) {
			this.closePopover();
			return;
		}
		const ids = orderedAskIds(this.store.page, passageY);
		const last = this.store.lastAskId;
		const id = last && ids.includes(last) ? last : ids[0];
		if (id) this.focusAsk(id, false);
	}

	private updateAnchorRect(): void {
		const open = this.store.popover;
		if (!open) return;
		const rect = this.glyphs.passageRectOf(open.askId) ?? this.glyphs.rectOf(open.askId);
		this.store.anchorRect = rect ? rectOf(rect) : null;
	}

	/** A plain click on a highlighted passage opens its note, as the mark in the margin does. */
	private onDocumentClick(e: MouseEvent): void {
		if (e.button !== 0 || e.defaultPrevented || !this.glyphs) return;
		if (e.composedPath().includes(this.host)) return;
		const sel = document.getSelection();
		if (sel && !sel.isCollapsed) return;
		const target = e.target as Element | null;
		if (target?.closest('a, button, input, textarea, select, [contenteditable]')) return;
		const id = this.glyphs.askAt(e.clientX, e.clientY);
		if (id) this.togglePopover(id);
	}

	private actions(): Actions {
		return {
			openComposer: () => this.openComposer(),
			cancelComposer: () => this.cancelComposer(),
			send: (text) => void this.send(text),
			launchApp: () => this.launchApp(),
			closePopover: () => this.closePopover(),
			stepNote: (delta) => this.stepNote(delta),
			toggleNote: () => this.toggleNote(),
			hideNavigator: () => {
				this.navigatorHidden = true;
				this.bump();
			},
			moveNavigator: (top) => {
				const fraction = fractionOf(top, this.dock.viewport().height);
				this.dock.setFraction(fraction);
				void localSet(NAV_HEIGHT_KEY, fraction);
			},
			followUp: async (askId, text) => {
				const entry = this.store.page.asks.get(askId);
				if (!entry) return;
				try {
					const r = await this.client.request<FollowUpResult>('followUp', { clarificationId: askId, question: text });
					addFollowUp(this.store.page, askId, r);
					this.bump();
				} catch (e) {
					this.store.showToast(describeFailure(e));
				}
			},
			cancel: (askId) => {
				const conversationId = this.store.page.asks.get(askId)?.clarification.conversationId ?? this.store.page.conversationId;
				if (conversationId) this.client.request('cancel', { conversationId }).catch(() => {});
			},
			collapse: (askId) => {
				setOpen(this.store.page, askId, false);
				this.glyphs.update(askId, { open: false });
				this.closePopover();
				this.bump();
				this.client.request('setOpen', { clarificationId: askId, open: false }).catch(() => {});
			},
			remove: async (askId) => {
				try {
					await this.client.request('deleteAsk', { clarificationId: askId });
				} catch (e) {
					this.store.showToast(describeFailure(e));
					return;
				}
				this.forgetAsk(askId);
				removeAsk(this.store.page, askId);
				this.subscribe();
				this.bump();
			},
			openInGloss: async (askId) => {
				const urlKey = this.store.page.urlKey;
				try {
					await this.client.request('openInGloss', { urlKey, clarificationId: askId });
				} catch (e) {
					if (failureOf(e).code === 'app_not_running') this.client.request('launchApp', { urlKey }).catch(() => {});
					else this.store.showToast(describeFailure(e));
				}
			},
		};
	}

	// ---- messages from the background --------------------------------------

	private onEvent(event: string, data: unknown): void {
		switch (event) {
			case 'connection': {
				const status = data as ConnectionStatus;
				this.store.connection = status;
				this.applySettings(status.settings);
				if (status.state === 'connected' && !this.store.page.urlKey) void this.loadPage();
				break;
			}
			case 'settings':
				this.applySettings(data as ExtensionSettings);
				break;
			case 'app_state': {
				const s = data as AppStateEventData;
				if (!s.running) break;
				const composer = this.store.composer;
				if (composer && (composer.phase === 'app_down' || composer.phase === 'launching')) {
					if (this.launchTimer) clearTimeout(this.launchTimer);
					this.launchTimer = null;
					void this.send(composer.text);
				}
				if (!this.store.page.urlKey) void this.loadPage();
				break;
			}
			case 'turn':
				applyTurnEvent(this.store.page, data as TurnEventEnvelope);
				this.bump();
				break;
			case 'page': {
				const p = data as PageEventData;
				if (p.deleted) {
					for (const id of [...this.store.page.asks.keys()]) this.forgetAsk(id);
					clearPage(this.store.page);
					this.subscribe();
					this.bump();
				} else {
					void this.loadPage();
				}
				break;
			}
			case 'shutdown':
				break;
		}
	}

	private applySettings(settings: ExtensionSettings): void {
		this.settings = settings;
		if (isDeniedHost(location.hostname, settings.denyList)) this.dispose();
	}

	private readonly onTabMessage = (msg: TabMessage, _sender: unknown, sendResponse: (r: unknown) => void): void => {
		switch (msg.type) {
			case 'ping':
				sendResponse({ ok: true });
				return;
			case 'open-composer':
				this.openComposer();
				sendResponse({ ok: true });
				return;
			case 'navigator-state': {
				const reply: NavigatorState = { hidden: this.navigatorHidden, notes: this.store.page.asks.size };
				sendResponse(reply);
				return;
			}
			case 'show-navigator':
				this.navigatorHidden = false;
				this.bump();
				sendResponse({ ok: true });
				return;
			case 'page-text': {
				const reply: PageTextReply = { ...this.pageMeta(), text: this.pageText() };
				sendResponse(reply);
				return;
			}
			case 'focus-ask': {
				sendResponse({ ok: this.focusAsk(msg.clarificationId, true) });
				return;
			}
		}
	};
}

function isEditable(node: Node): boolean {
	const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	if (!el) return false;
	if (el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return true;
	return (el as HTMLElement).isContentEditable === true;
}

/** The last non-empty client rect of a range, where the pill and glyph sit. */
function lastRect(range: Range): DOMRect | null {
	const rects = range.getClientRects();
	for (let i = rects.length - 1; i >= 0; i--) {
		if (rects[i].width > 0 || rects[i].height > 0) return rects[i];
	}
	const r = range.getBoundingClientRect();
	return r.width || r.height ? r : null;
}

function faviconUrl(): string | null {
	const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"], link[rel="shortcut icon"]');
	if (link?.href) return link.href;
	try {
		return new URL('/favicon.ico', location.origin).href;
	} catch {
		return null;
	}
}

/**
 * The reason behind an `app_not_running` failure when the transport gave
 * one beyond the bare fact, such as Safari's handler naming a missing
 * bridge file; null for the plain case the composer already states.
 */
function appDownReason(f: BridgeFailure): string | null {
	const generic = /^gloss is(n't| not) running\.?$/i;
	return f.message && !generic.test(f.message.trim()) ? f.message : null;
}

function describeFailure(e: unknown): string {
	const f = failureOf(e);
	switch (f.code) {
		case 'app_not_running':
			return appDownReason(f) ?? "Gloss isn't running.";
		case 'busy':
			return 'Gloss is still answering another question on this page.';
		default:
			return f.message;
	}
}

/** How often `main` looks for a body to start in after the page took the UI out. */
const RESTART_POLL_MS = 200;

async function main(): Promise<void> {
	if (inPrivateContext()) return;
	if (window !== window.top) return;
	if (!/^https?:$/.test(location.protocol) && location.protocol !== 'file:') return;
	await start();
	// A page that rewrites itself with `document.open()` (Jira does while
	// it loads) removes the Gloss UI and erases its listeners. Watching the
	// document (a mutation observer, which `document.open()` leaves in
	// place) catches that, and the UI starts again once the new page has a
	// body.
	let restarting = false;
	new MutationObserver(() => {
		if (restarting || !app || app.onPage) return;
		restarting = true;
		app.dispose();
		app = null;
		const retry = () => {
			if (!document.body) return void setTimeout(retry, RESTART_POLL_MS);
			restarting = false;
			void start();
		};
		retry();
	}).observe(document, { childList: true, subtree: true });
}

let app: ContentApp | null = null;

async function start(): Promise<void> {
	if (!document.body || document.documentElement.querySelector(HOST_TAG)) return;
	const cached = (await storageGet<ExtensionSettings>(SETTINGS_KEY)) ?? DEFAULT_SETTINGS;
	if (isDeniedHost(location.hostname, cached.denyList)) return;
	app = new ContentApp(cached);
	app.start();
}

void main();
