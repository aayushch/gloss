// Title-bar behaviour for the app's own drag regions: the header and, on
// macOS, the strip beside the traffic lights. Press and move to drag the
// window, double-click to maximize or restore. The shell does the moving
// (see `start_drag` in docs/api.md); nothing happens in a plain browser.
import { api, inTauri } from '$lib/api/client';

/** Attach as `onmousedown` on a drag region. Presses on controls inside the
 * region (buttons, inputs, menus) are left to the control. */
export function titleMouseDown(e: MouseEvent): void {
	if (e.button !== 0 || e.detail > 2 || !inTauri()) return;
	if ((e.target as HTMLElement).closest('button, input, a, select, textarea, [role="menu"]')) return;
	e.preventDefault();
	api().then((a) => a.startDrag(e.detail)).catch(() => {});
}
