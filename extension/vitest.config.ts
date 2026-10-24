// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'jsdom',
		globals: true,
		include: ['test/**/*.test.ts']
	},
	define: { __BROWSER__: JSON.stringify('chrome') }
});
