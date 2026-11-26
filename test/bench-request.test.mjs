// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import {
	assertParity,
	buildCase,
	caseList,
	owns,
	prepareV1,
	runChild,
	writeLoader,
} from '../scripts/bench-request.mjs'

const checkout = resolve(import.meta.dirname, '..')
const dir = mkdtempSync(join(tmpdir(), 'cvx-bench-request-test-'))
// v1 is extracted from commit 8d979a5 with `git archive`; in a shallow clone it is unavailable and
// only the v2 cases are built and checked.
const v1 = prepareV1()
afterAll(() => {
	rmSync(dir, { recursive: true, force: true })
	v1.cleanup?.()
})

const cases = caseList.filter((item) => item.side === 'v2' || !v1.reason)
const built = {}
let loader
beforeAll(async () => {
	loader = writeLoader(dir)
	for (const item of cases) {
		const out = join(dir, `${item.name.replaceAll(' ', '-')}.mjs`)
		built[item.name] = { out, bundle: await buildCase(item, out, v1.root) }
	}
}, 60_000)

describe('request fixtures', () => {
	it.each(cases.map((item) => item.name))(
		'%s bundles, evaluates, registers five functions and calls each one',
		(name) => {
			const check = runChild(loader, built[name].out, 'check')
			expect(Object.keys(check.snapshot)).toEqual(['create', 'update', 'get', 'list', 'archive'])
			expect(check.results.create._id).toEqual(expect.any(String))
			expect(check.results.list).toEqual([])
			expect(check.rejected).toBe(true)
			const sample = runChild(loader, built[name].out, 'request')
			for (const key of ['load', 'retainedMB', 'tables', 'auth', 'registration', 'firstCall'])
				expect(sample[key], key).toEqual(expect.any(Number))
		},
	)

	it('push identical exportArgs/exportReturns JSON and call results from every v2 variant', () => {
		const reference = runChild(loader, built['v2 eager'].out, 'check')
		assertParity(reference, runChild(loader, built['v2 getter'].out, 'check'), 'v2 getter')
	})

	it.skipIf(Boolean(v1.reason))(
		'v2 pushes the same exportArgs/exportReturns JSON and call results as v1 (8d979a5)',
		() => {
			const reference = runChild(loader, built['v1 eager'].out, 'check')
			for (const name of ['v1 getter', 'v2 eager', 'v2 getter'])
				assertParity(reference, runChild(loader, built[name].out, 'check'), name)
		},
	)

	it('parity check fails on a differing export', () => {
		const reference = runChild(loader, built['v2 eager'].out, 'check')
		const changed = structuredClone(reference)
		changed.snapshot.get[1] = '"null"'
		expect(() => assertParity(reference, changed, 'changed')).toThrow(/exportReturns\(\) of get/)
	})
})

describe('bundle attribution', () => {
	it('v2 carries no Zod', () => {
		for (const name of ['v2 eager', 'v2 getter']) {
			const { bundle } = built[name]
			expect(bundle.packages.zod ?? 0, name).toBe(0)
			for (const file of Object.keys(bundle.files))
				expect(file).not.toMatch(/src\/zod|convex-helpers\/server\/zod/)
		}
	})

	it.skipIf(Boolean(v1.reason))('v1 (8d979a5) carries Zod and the v1 table module', () => {
		const { bundle } = built['v1 eager']
		expect(bundle.packages.zod).toBeGreaterThan(500_000)
		expect(Object.keys(bundle.files).some((file) => file.endsWith('src/zod-table.ts'))).toBe(true)
	})

	it('attributes inputs to their owner', () => {
		expect(owns('node_modules/zod/v4/core/core.js')).toBe('zod')
		expect(owns('node_modules/convex-helpers/server/zod4.js')).toBe('convex-helpers')
		expect(owns('src/k/parse.ts')).toBe('src/k')
		expect(owns('src/table.ts')).toBe('src (rest)')
		expect(owns('scripts/bench/request/v2-fixture.ts')).toBe('fixture')
		expect(owns('/tmp/v1/scripts/bench/request/v1-fixture.ts', '/tmp/v1')).toBe('fixture')
		expect(owns('/tmp/v1/src/zod-table.ts', '/tmp/v1')).toBe('src (rest)')
	})

	it('the v2 table graph alone (src/table.ts and src/k.ts) has no Zod bytes', async () => {
		const esbuild = createRequire(join(checkout, 'package.json'))('esbuild')
		const entry = join(dir, 'tables-only.ts')
		writeFileSync(
			entry,
			`import { k } from '${join(checkout, 'src/k.ts')}'
import { kTable } from '${join(checkout, 'src/table.ts')}'
const t = kTable('entity1', { title: k.string().min(1), parentId: k.id('entity0').optional() }, { publicFields: ['title'] })
export const native = [t.table, t.dto(true).validator, t.commandInput.validator]
`,
		)
		const result = await esbuild.build({
			absWorkingDir: checkout,
			entryPoints: [entry],
			bundle: true,
			platform: 'browser',
			format: 'esm',
			outfile: join(dir, 'tables-only.mjs'),
			conditions: ['convex', 'module'],
			logLevel: 'silent',
			metafile: true,
		})
		const output = Object.values(result.metafile.outputs).find((item) => item.entryPoint)
		const zodBytes = Object.entries(output.inputs)
			.filter(([input]) => /node_modules\/zod\/|convex-helpers\/server\/zod/.test(input))
			.reduce((sum, [, { bytesInOutput }]) => sum + bytesInOutput, 0)
		expect(zodBytes).toBe(0)
	})
})
