// The content script: shows the "Ask about this" pill on a selection, the
// composer, the glyphs and the reply popover; anchors every ask of the
// page on load and keeps it anchored as the page changes. It talks to
// Gloss only through the background.

import { mount, unmount } from 'svelte';
import { browser, inPrivateContext, SETTINGS_KEY, storageGet } from '../shared/browser';
import { connectClient, type Client } from '../shared/client';
import type { BackgroundMessage, ConnectionStatus, PageTextReply, TabMessage } from '../shared/messages';
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
import { GlyphLayer } from './glyphs';
import { HighlightLayer } from './highlight';
import { addAsk, addFollowUp, applyTurnEvent, clearPage, loadPage, removeAsk, setAnchor, setOpen, type AskEntry } from './state';
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
	private readonly reresolveIds = new Set<string>();
	private stopUrlWatch: (() => void) | null = null;
	private disposed = false;
	private readonly listeners: [EventTarget, string, EventListener, AddEventListenerOptions | boolean | undefined][] = [];

	constructor(private settings: ExtensionSettings) {}

	start(): void {
		this.host = document.createElement(HOST_TAG);
		// Modal dialogs on the page trap focus inside themselves and pull it
		// back when it moves elsewhere, which would make the composer's box
		// impossible to type into. react-focus-lock (Atlassian, many React
		// apps) leaves focus alone inside an element carrying this attribute,
		// and the two listeners below keep the focus events of the Gloss UI
		// from reaching the document-level handlers other trap libraries
		// install, since the document sees them as happening on the host.
		this.host.setAttribute('data-no-focus-lock', '');
		this.host.addEventListener('focusin', (e) => e.stopPropagation());
		this.host.addEventListener('focusout', (e) => e.stopPropagation());
		this.shadow = this.host.attachShadow({ mode: 'closed' });
		const style = document.createElement('style');
		style.textContent = styles;
		this.shadow.appendChild(style);
		const glyphRoot = document.createElement('div');
		glyphRoot.className = 'gloss-glyphs';
		this.shadow.appendChild(glyphRoot);
		const uiRoot = document.createElement('div');
		this.shadow.appendChild(uiRoot);
		document.documentElement.appendChild(this.host);

		this.highlights = new HighlightLayer(document);
		this.glyphs = new GlyphLayer(glyphRoot, {
			onClick: (id) => this.togglePopover(id),
			onDetached: (id) => this.queueReresolve(id),
			onReposition: () => this.updateAnchorRect(),
		});
		this.mutations = new MutationObserver(() => (this.indexDirty = true));
		this.mutations.observe(document.body, { childList: true, subtree: true, characterData: true });

		this.app = mount(App, { target: uiRoot, props: { store: this.store, actions: this.actions() } });

		this.client = connectClient();
		this.client.onEvent((event, data) => this.onEvent(event, data));
		this.client.onCommand((msg) => this.onCommand(msg));

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
		this.stopUrlWatch?.();
		this.mutations?.disconnect();
		for (const t of this.retryTimers) clearTimeout(t);
		if (this.reresolveTimer) clearTimeout(this.reresolveTimer);
		if (this.launchTimer) clearTimeout(this.launchTimer);
		this.glyphs.dispose();
		this.highlights.dispose();
		if (this.app) void unmount(this.app);
		this.host.remove();
		this.client.close();
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
			this.store.bump();
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
		const states: Record<string, AnchorState> = {};
		for (const [id, entry] of this.store.page.asks) {
			if (entry.state !== 'pending') continue;
			this.resolveOne(id, entry);
			states[id] = entry.state as AnchorState;
		}
		this.report(states);
		this.store.bump();
	}

	/** Resolves one ask against the current index and updates its highlight and glyph. */
	private resolveOne(id: string, entry: AskEntry): void {
		const anchor = entry.clarification.webAnchor;
		if (!anchor) return;
		const index = this.textIndex();
		const found = resolve(anchor, index);
		if (entry.range) this.highlights.remove(entry.range);
		if (!found) {
			setAnchor(this.store.page, id, null, 'orphan');
			this.glyphs.remove(id);
			if (this.store.popover?.askId === id) this.store.anchorRect = null;
			return;
		}
		setAnchor(this.store.page, id, found.range, found.state);
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

	private report(states: Record<string, AnchorState>): void {
		if (!Object.keys(states).length) return;
		this.client.request('reportAnchors', { states }).catch(() => {});
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
					const states: Record<string, AnchorState> = {};
					for (const [id, entry] of this.store.page.asks) {
						if (entry.state !== 'orphan') continue;
						this.resolveOne(id, entry);
						if (entry.state !== 'orphan') states[id] = entry.state as AnchorState;
					}
					this.report(states);
					this.store.bump();
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
			const states: Record<string, AnchorState> = {};
			for (const id of ids) {
				const entry = this.store.page.asks.get(id);
				if (!entry) continue;
				const before = entry.state;
				this.resolveOne(id, entry);
				if (entry.state !== before) states[id] = entry.state as AnchorState;
			}
			this.report(states);
			this.store.bump();
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
		this.highlights.clear();
		this.glyphs.clear();
		this.indexDirty = true;
		for (const [id] of this.store.page.asks) setAnchor(this.store.page, id, null, 'pending');
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
				this.highlights.add(pending.range);
				this.glyphs.set(result.clarification.id, pending.range, { open: true, active: false, fuzzy: false });
				this.openPopover(result.clarification.id);
			}
			this.subscribe();
			this.store.bump();
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
		this.highlights.setActive(entry.range);
		this.glyphs.update(id, { active: true });
		this.updateAnchorRect();
		if (!entry.clarification.open) {
			setOpen(this.store.page, id, true);
			this.glyphs.update(id, { open: true });
			this.store.bump();
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
			followUp: async (askId, text) => {
				const entry = this.store.page.asks.get(askId);
				if (!entry) return;
				try {
					const r = await this.client.request<FollowUpResult>('followUp', { clarificationId: askId, question: text });
					addFollowUp(this.store.page, askId, r);
					this.store.bump();
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
				this.store.bump();
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
				this.store.bump();
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
				this.store.bump();
				break;
			case 'page': {
				const p = data as PageEventData;
				if (p.deleted) {
					for (const id of [...this.store.page.asks.keys()]) this.forgetAsk(id);
					clearPage(this.store.page);
					this.subscribe();
					this.store.bump();
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

	private onCommand(msg: BackgroundMessage): void {
		if (msg.type === 'open-composer') this.openComposer();
	}

	private readonly onTabMessage = (msg: TabMessage, _sender: unknown, sendResponse: (r: unknown) => void): void => {
		switch (msg.type) {
			case 'ping':
				sendResponse({ ok: true });
				return;
			case 'page-text': {
				const reply: PageTextReply = { ...this.pageMeta(), text: this.pageText() };
				sendResponse(reply);
				return;
			}
			case 'focus-ask': {
				const entry = this.store.page.asks.get(msg.clarificationId);
				if (!entry) {
					sendResponse({ ok: false });
					return;
				}
				if (entry.range && entry.state !== 'orphan') this.glyphs.scrollTo(msg.clarificationId);
				else this.store.showToast("This note's passage is no longer on the page.");
				this.openPopover(msg.clarificationId);
				setTimeout(() => this.updateAnchorRect(), 400);
				sendResponse({ ok: true });
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

async function main(): Promise<void> {
	if (inPrivateContext()) return;
	if (window !== window.top) return;
	if (!document.body || document.documentElement.querySelector(HOST_TAG)) return;
	if (!/^https?:$/.test(location.protocol) && location.protocol !== 'file:') return;
	const cached = (await storageGet<ExtensionSettings>(SETTINGS_KEY)) ?? DEFAULT_SETTINGS;
	if (isDeniedHost(location.hostname, cached.denyList)) return;
	new ContentApp(cached).start();
}

void main();
