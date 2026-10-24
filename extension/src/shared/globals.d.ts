// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

/** The build target, injected by build.mjs as an esbuild define. */
declare const __BROWSER__: 'chrome' | 'firefox' | 'safari';

/** Raw text of a CSS file, imported as a string by the content-script build. */
declare module '*.css' {
	const text: string;
	export default text;
}
