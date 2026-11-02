// Interleave fresh-process imports of identical fixtures across source roots.
// Usage: node scripts/bench-module-load.mjs RECEIPT_DIR RUNS label=root ...
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const args = process.argv.slice(2)
const jit = args.includes('--jit')
const [receipt, count = '15', ...sources] = args.filter((arg) => arg !== '--jit')
if (!receipt || sources.length < 2)
	throw new Error('Provide receipt directory, runs, and label=root pairs')
const runs = Number(count)
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('Invalid run count')
fs.mkdirSync(receipt, { recursive: true })
const here = path.dirname(new URL(import.meta.url).pathname)
const esbuild = createRequire(path.join(here, '..', 'package.json'))('esbuild')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvx-module-load-'))
const cases = []
try {
	for (const source of sources) {
		const split = source.indexOf('=')
		const label = source.slice(0, split)
		const root = path.resolve(source.slice(split + 1))
		for (const workload of ['module-load', 'eager-module-load']) {
			for (const lazy of [false, true]) {
				// 0.1.25 has no thunk API; its identical object workload is the reference.
				if (label === '0.1.25' && lazy) continue
				const name = `${label}-${workload}-${lazy ? 'thunk' : 'object'}`
				const out = path.join(dir, `${name}.mjs`)
				await esbuild.build({
					absWorkingDir: root,
					entryPoints: [path.join(root, `scripts/bench/${workload}-entry.ts`)],
					bundle: true,
					platform: 'browser',
					format: 'esm',
					target: 'esnext',
					outfile: out,
					conditions: ['convex', 'module'],
					treeShaking: true,
					minifySyntax: true,
					minifyIdentifiers: true,
					keepNames: true,
					define: {
						'process.env.NODE_ENV': '"production"',
						__CVX_BENCH_LAZY_CONTRACTS__: String(lazy),
					},
					logLevel: 'error',
					external: ['node:*'],
				})
				cases.push({ name, out, samples: [] })
			}
		}
	}
	const loader = path.join(dir, 'load.mjs')
	fs.writeFileSync(
		loader,
		`const start = performance.now()
const m = await import(process.argv[2])
const sample = { load: performance.now() - start, ...m.timings }
console.log(JSON.stringify({ sample, snapshot: process.argv[3] === 'snapshot' ? m.snapshot?.() : undefined }))
`,
	)
	let expected
	for (let round = 0; round < runs; round++) {
		// Rotate the starting case each round to spread drift across all versions.
		for (let offset = 0; offset < cases.length; offset++) {
			const item = cases[(round + offset) % cases.length]
			const { sample, snapshot } = JSON.parse(
				execFileSync(
					process.execPath,
					[
						...(jit ? [] : ['--jitless']),
						'--no-warnings',
						loader,
						item.out,
						...(round === 0 ? ['snapshot'] : []),
					],
					{ maxBuffer: 16 * 1024 * 1024 },
				).toString(),
			)
			item.samples.push(sample)
			if (snapshot) {
				expected ??= snapshot
				assert.deepEqual(snapshot, expected, `Output differs: ${item.name}`)
			}
		}
	}
	const quantile = (values, p) =>
		[...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)]
	const results = cases.map(({ name, samples }) => ({
		name,
		samples,
		distribution: Object.fromEntries(
			Object.keys(samples[0]).map((key) => {
				const values = samples.map((sample) => sample[key])
				return [
					key,
					{
						min: Math.min(...values),
						p25: quantile(values, 0.25),
						median: quantile(values, 0.5),
						p75: quantile(values, 0.75),
						max: Math.max(...values),
					},
				]
			}),
		),
	}))
	fs.writeFileSync(
		path.join(receipt, 'results.json'),
		JSON.stringify({ node: process.version, jit, runs, sources, results }, null, 2),
	)
	fs.writeFileSync(path.join(receipt, 'output.json'), JSON.stringify(expected, null, 2))
	console.log(
		JSON.stringify(
			results.map(({ name, distribution }) => ({
				name,
				...Object.fromEntries(
					Object.entries(distribution).map(([key, value]) => [key, +value.median.toFixed(2)]),
				),
			})),
			null,
			2,
		),
	)
} finally {
	fs.rmSync(dir, { recursive: true, force: true })
}
