import { defineConfig } from 'vite-plus'

export default defineConfig({
	test: {
		environment: 'edge-runtime',
	},

	// Library build: `vp pack` (tsdown on Rolldown) reads this key.
	pack: {
		// test.ts ships as source (vitest-only helper); never built.
		entry: ['src/**/*.ts', '!src/**/__tests__/**', '!src/test.ts'],
		format: 'esm',
		target: 'es2025',
		unbundle: true,
		dts: true,
		sourcemap: true,
		minify: true,
		clean: true,
		publint: true,
	},
})
