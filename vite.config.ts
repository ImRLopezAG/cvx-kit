import { defineConfig } from 'vite-plus'
import packageManifest from './package.json' with { type: 'json' }

export default defineConfig({
	lint: {
		ignorePatterns: [
			'.agent/**',
			'.agents/**',
			'.claude/**',
			'.codex/**',
			'.continue/**',
			'.cursor/**',
			'.gemini/**',
			'.opencode/**',
			'.pi/**',
			'.roo/**',
			'.windsurf/**',
			'dist/**',
			'**/_generated/**',
			'tools/oxlint/anti-slop/**',
		],
		jsPlugins: [
			{ name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' },
			{ name: 'cvx', specifier: './tools/oxlint/cvx/index.ts' },
		],
		rules: {
			'anti-slop/no-chained-type-assertions': 'error',
			'anti-slop/no-conditional-empty-object-spread': 'error',
			'anti-slop/no-known-value-widening': 'error',
			'anti-slop/no-module-mocking': 'error',
			'anti-slop/no-object-parameters': 'error',
			'anti-slop/no-reflect-apply': 'error',
			'anti-slop/no-reflect-get': 'error',
			'anti-slop/no-runtime-typeof': 'error',
			'anti-slop/no-shape-in-symbol-names': 'error',
			'anti-slop/no-unknown-parameters': 'error',
			'anti-slop/no-unknown-returns': 'error',
			'anti-slop/no-unknown-type-aliases': 'error',
			'anti-slop/no-unsafe-dictionary-type': 'error',
			'anti-slop/no-widen-then-assert': 'error',
			'anti-slop/require-safety-comment-for-type-assertion': 'error',
		},
		overrides: [
			{
				files: ['src/**/*.ts'],
				excludeFiles: ['**/__tests__/**', 'src/test.ts'],
				rules: {
					'cvx/component-boundaries': ['error', { packageName: packageManifest.name }],
					'cvx/no-component-env': 'error',
					'cvx/schema-file-boundaries': 'error',
					'cvx/no-internal-reexports': [
						'error',
						{
							entryPoints: [
								'src/index.ts',
								...Object.keys(packageManifest.exports)
									.filter((path) => /^\.\/[^/.]+$/.test(path))
									.map((path) => `src/${path.slice(2)}.ts`),
							],
						},
					],
					'cvx/public-api-first': 'error',
					'cvx/named-private-helpers': 'error',
				},
			},
		],
	},
	fmt: {
		useTabs: true,
		singleQuote: true,
		semi: false,
		ignorePatterns: [
			'.agent/**',
			'.agents/**',
			'.claude/**',
			'.codex/**',
			'.continue/**',
			'.cursor/**',
			'.gemini/**',
			'.opencode/**',
			'.pi/**',
			'.roo/**',
			'.windsurf/**',
			'dist/**',
			'**/_generated/**',
			'tools/oxlint/anti-slop/**',
		],
	},
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
		// publint runs as a separate build step AFTER the convex.config.js
		// bridge is materialized (see scripts/convex-config-bridge.mjs).
		publint: false,
	},
})
