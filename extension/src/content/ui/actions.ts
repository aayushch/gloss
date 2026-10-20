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
	/** Shows the next (1) or previous (-1) note in reading order, scrolling to its passage. */
	stepNote(delta: 1 | -1): void;
	/** Opens the navigator's current note, or closes it when it is showing. */
	toggleNote(): void;
	/** Takes the navigator off the page until the next ask or page load. */
	hideNavigator(): void;
	/** The reader dropped the navigator at this viewport top; it is kept at that height on every site. */
	moveNavigator(top: number): void;
}
