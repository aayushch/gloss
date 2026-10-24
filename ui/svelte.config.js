// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// Tauri serves the built files from disk, so the whole app is a single
		// static page with client-side rendering only.
		adapter: adapter({ fallback: 'index.html' })
	}
};

export default config;
