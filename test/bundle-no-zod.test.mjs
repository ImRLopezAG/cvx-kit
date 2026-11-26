// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vite-plus/test'

const checkout = resolve(import.meta.dirname, '..')
const esbuild = createRequire(join(checkout, 'package.json'))('esbuild')
const manifest = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'))
const dir = mkdtempSync(join(tmpdir(), 'cvx-bundle-no-zod-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/**
 * Every package entry except the opt-in `./zod` interop entry, as its `src/` file: the export's
 * built target with `dist/` mapped back to `src/`. Skipped: `./package.json`, the type-only component
 * `_generated` exports (no runtime target) and `./test`, the vitest-only helper that ships as source
 * and loads the built components from `dist/`, so it never reaches a Convex bundle.
 */
const coreEntries = [
	...new Set(
		Object.entries(manifest.exports)
			.filter(([path]) => !['./package.json', './zod', './test'].includes(path))
			// A string export is its own target; a conditional one runs its `import` target.
			.flatMap(([, target]) => (target.types === undefined ? [target] : (target.import ?? [])))
			.map((target) => target.replace(/^\.\/dist\//, 'src/').replace(/\.(mjs|js)$/, '.ts')),
	),
]
/** The lint plugin runs in Node beside native oxc bindings, never in a Convex bundle. */
const nodeOnly = new Set(['src/oxlint.ts'])
const zodInputs = [/node_modules\/zod\//, /node_modules\/convex-helpers\/(dist\/)?server\/zod/]

/** Bundle a module that re-exports `entries` like Convex does, and return the input bytes by path. */
async function bundleInputs(name, entries, imports = [], node = false) {
	const entry = join(dir, `${name}.ts`)
	writeFileSync(
		entry,
		[
			...imports.map((file) => `import '${join(checkout, file)}'\n`),
			...entries.map((file) => `export * from '${join(checkout, file)}'\n`),
		].join(''),
	)
	const result = await esbuild.build({
		absWorkingDir: checkout,
		entryPoints: [entry],
		bundle: true,
		platform: node ? 'node' : 'browser',
		format: 'esm',
		target: 'esnext',
		outfile: join(dir, `${name}.mjs`),
		conditions: ['convex', 'module'],
		treeShaking: true,
		logLevel: 'silent',
		external: node ? ['node:*', 'oxc-parser', 'oxc-resolver', '@oxlint/plugins'] : ['node:*'],
		metafile: true,
	})
	const output = Object.values(result.metafile.outputs).find((item) => item.entryPoint)
	return Object.entries(output.inputs)
		.filter(([, { bytesInOutput }]) => bytesInOutput > 0)
		.map(([input, { bytesInOutput }]) => ({ input, bytes: bytesInOutput }))
}

function bytesMatching(inputs, patterns) {
	return inputs
		.filter(({ input }) => patterns.some((pattern) => pattern.test(input)))
		.reduce((sum, { bytes }) => sum + bytes, 0)
}

describe('v2 bundles', () => {
	it('derive the core entries from every package export except the interop entry', () => {
		expect(coreEntries).toContain('src/index.ts')
		expect(coreEntries).toContain('src/k.ts')
		expect(coreEntries).toContain('src/components/foundation/convex.config.ts')
		expect(coreEntries).not.toContain('src/zod.ts')
		expect(coreEntries.length).toBeGreaterThan(25)
	})

	it.each(coreEntries)('contain no Zod or convex-helpers zod4 bytes from %s', async (entry) => {
		const inputs = await bundleInputs(entry.replaceAll('/', '_'), [entry], [], nodeOnly.has(entry))
		expect(bytesMatching(inputs, zodInputs)).toBe(0)
	})

	it('contain Zod once the interop entry is imported', async () => {
		const inputs = await bundleInputs('interop', [
			...coreEntries.filter((entry) => !nodeOnly.has(entry)),
			'src/zod.ts',
		])
		expect(bytesMatching(inputs, [zodInputs[0]])).toBeGreaterThan(0)
		// Ids convert to an own zod/mini schema, so convex-helpers' Zod adapter stays out.
		expect(bytesMatching(inputs, [zodInputs[1]])).toBe(0)
	})

	it('build the interop entry on zod/mini, well under the classic bundle', async () => {
		const inputs = await bundleInputs('interop-size', ['src/k.ts'], ['src/zod.ts'])
		// Classic Zod is over 700 KB here; zod/mini alone is about 73 KB.
		expect(bytesMatching(inputs, [zodInputs[0]])).toBeLessThan(80_000)
		expect(bytesMatching(inputs, [/node_modules\/zod\/v4\/classic\//])).toBe(0)
		expect(bytesMatching(inputs, [/node_modules\/convex-helpers\//])).toBe(0)
		expect(bytesMatching(inputs, [/node_modules\/zod\/v4\/mini\//])).toBeGreaterThan(0)
		expect(bytesMatching(inputs, [/node_modules\/zod\/v4\/locales\/(?!en\.)/])).toBe(0)
	})

	it('keep the interop entry when it is imported only for its side effect', async () => {
		const inputs = await bundleInputs('side-effect', ['src/k.ts'], ['src/zod.ts'])
		expect(bytesMatching(inputs, [zodInputs[0]])).toBeGreaterThan(0)
		expect(bytesMatching(inputs, [/src\/zod\.ts$/])).toBeGreaterThan(0)
	})

	it('keep src/json-schema.ts out of a module that imports only cvx-kit/k', async () => {
		const inputs = await bundleInputs('k-only', ['src/k.ts'])
		expect(bytesMatching(inputs, [/src\/json-schema\.ts$/])).toBe(0)
		expect(bytesMatching(inputs, [/src\/k\//])).toBeGreaterThan(0)
	})

	it('keep server code and Zod out of the browser-safe cvx-kit/filters entry', async () => {
		const inputs = await bundleInputs('filters', ['src/filters.ts'])
		expect(bytesMatching(inputs, zodInputs)).toBe(0)
		const server = [
			/node_modules\/convex\/dist\/esm\/server\//,
			/node_modules\/convex-helpers\//,
			/node_modules\/@noble\//,
			/src\/querying\/(?!shared\/)/,
			/src\/(table|registration|zod[^/]*)\.ts$/,
		]
		expect(inputs.filter(({ input }) => server.some((pattern) => pattern.test(input)))).toEqual([])
		expect(bytesMatching(inputs, [/src\/querying\/shared\/contract\.ts$/])).toBeGreaterThan(0)
	})
})

describe('v1 removal', () => {
	/** Every TypeScript source file under src/, relative to the checkout. */
	function sourceFiles(folder = join(checkout, 'src')) {
		return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
			const path = join(folder, entry.name)
			if (entry.isDirectory()) return sourceFiles(path)
			return /\.tsx?$/.test(entry.name) ? [relative(checkout, path)] : []
		})
	}
	const zodImport =
		/(?:from|import)\s*\(?\s*['"](?:zod(?:\/[^'"]*)?|convex-helpers\/server\/zod4)['"]/

	it('leaves src/zod.ts as the only source file importing zod or convex-helpers zod4', () => {
		const importing = sourceFiles().filter((file) =>
			zodImport.test(readFileSync(join(checkout, file), 'utf8')),
		)
		expect(importing).toEqual(['src/zod.ts'])
	})

	it('publishes no ./zod-table entry and keeps zod an optional peer', () => {
		expect(manifest.exports['./zod-table']).toBeUndefined()
		expect(manifest.peerDependenciesMeta.zod).toEqual({ optional: true })
	})
})
