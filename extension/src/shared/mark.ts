// The quote mark of the Gloss icon as inline SVG, so the mark on the page,
// in the pill and in the popover is the same shape the app icon shows. It
// is sized by the surrounding font size (`width: 1em`) and filled with the
// current text colour, see `.gloss-mark-svg` in content/styles.css and shared/pages.css.

export const MARK_SVG =
	'<svg class="gloss-mark-svg" viewBox="136 120 188 116" aria-hidden="true" focusable="false">' +
	'<g transform="rotate(180 230 178)">' +
	'<path d="M136 236 V176 Q136 120 192 120 H200 V156 H196 Q176 156 176 176 V184 H212 V236 Z"/>' +
	'<path d="M248 236 V176 Q248 120 304 120 H312 V156 H308 Q288 156 288 176 V184 H324 V236 Z"/>' +
	'</g></svg>';
