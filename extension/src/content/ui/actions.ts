// What the in-page components can ask the content script to do.

export interface Actions {
	openComposer(): void;
	cancelComposer(): void;
	send(text: string): void;
	launchApp(): void;
	followUp(askId: string, text: string): void;
	cancel(askId: string): void;
	collapse(askId: string): void;
	remove(askId: string): void;
	openInGloss(askId: string): void;
	closePopover(): void;
}
