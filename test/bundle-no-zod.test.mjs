// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vite-plus/test'

const checkout = resolve(import.meta.dirname, '..')
const esbuild = createRequire(join(checkout, 'package.json'))('esbuild')
const dir = mkdtempSync(join(tmpdir(), 'cvx-bundle-no-zod-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/**
 * v2 core entries that must never pull Zod into a Convex function bundle. Append each new v2 entry
 * (src/table.ts, src/registration.ts, ...) here; v1 entries still import Zod until the cutover.
 */
const coreEntries = ['src/k.ts', 'src/json-schema.ts', 'src/table.ts', 'src/registration.ts']
const zodInputs = [/node_modules\/zod\//, /node_modules\/convex-helpers\/server\/zod4/]

/** Bundle a module that re-exports `entries` like Convex does, and return the input bytes by path. */
async function bundleInputs(name, entries, imports = []) {
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
		platform: 'browser',
		format: 'esm',
		target: 'esnext',
		outfile: join(dir, `${name}.mjs`),
		conditions: ['convex', 'module'],
		treeShaking: true,
		logLevel: 'silent',
		external: ['node:*'],
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
	it('contain no Zod or convex-helpers zod4 bytes from the core entries', async () => {
		const inputs = await bundleInputs('core', coreEntries)
		expect(bytesMatching(inputs, zodInputs)).toBe(0)
	})

	it('contain Zod once the interop entry is imported', async () => {
		const inputs = await bundleInputs('interop', [...coreEntries, 'src/zod.ts'])
		expect(bytesMatching(inputs, [zodInputs[0]])).toBeGreaterThan(0)
		expect(bytesMatching(inputs, [zodInputs[1]])).toBeGreaterThan(0)
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
})
