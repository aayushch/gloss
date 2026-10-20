// How the background reaches Gloss. Chrome and Firefox keep a native
// messaging port open to the `gloss-bridge` host, which pushes events;
// Safari can only exchange one message at a time and polls instead.

export type TransportState = 'disconnected' | 'connecting' | 'connected';

export type TransportEventHandler = (event: string, data: unknown) => void;

export interface Transport {
	/** Sends one request and resolves with its result; rejects with a BridgeFailure. */
	request(method: string, params?: unknown): Promise<unknown>;
	/** Events from Gloss or the host: `turn`, `page`, `settings`, `shutdown`, `app_state`. */
	onEvent(handler: TransportEventHandler): () => void;
	onStateChange(handler: (state: TransportState, detail?: string) => void): () => void;
	readonly state: TransportState;
	/**
	 * True when the transport delivers pushed events on its own. A transport
	 * without pushes needs the session to probe after launching the app.
	 */
	readonly pushesEvents: boolean;
	/** Opens the connection when one is needed up front. */
	connect(): void;
}

/** Small event emitter shared by both transports. */
export class Emitter {
	private readonly events = new Set<TransportEventHandler>();
	private readonly states = new Set<(state: TransportState, detail?: string) => void>();

	onEvent(handler: TransportEventHandler): () => void {
		this.events.add(handler);
		return () => this.events.delete(handler);
	}

	onStateChange(handler: (state: TransportState, detail?: string) => void): () => void {
		this.states.add(handler);
		return () => this.states.delete(handler);
	}

	emit(event: string, data: unknown): void {
		for (const h of this.events) {
			try {
				h(event, data);
			} catch (e) {
				console.error('gloss: event handler failed', e);
			}
		}
	}

	emitState(state: TransportState, detail?: string): void {
		for (const h of this.states) h(state, detail);
	}
}

/** Picks the transport for the build target. */
export async function createTransport(): Promise<Transport> {
	if (__BROWSER__ === 'safari') {
		const { SafariTransport } = await import('./safari');
		return new SafariTransport();
	}
	const { NativePortTransport } = await import('./native');
	return new NativePortTransport();
}
