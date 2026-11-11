// Per-request module-load benchmark for a representative cvx-kit app.
// Bundles scripts/bench/app-module-load-entry.ts the way Convex does (browser,
// ESM, `convex,module` conditions), then imports it in fresh processes and
// reports evaluation time, retained heap and the cost of building one
// function's validators. Pushed function metadata must match across every
// source and variant.
//
// Usage: node scripts/bench-app-load.mjs [--runs N] [--source label=root ...]
//          [--check scripts/bench/app-load-budget.json] [--receipt DIR] [--profile DIR]
// Without --source, the checkout itself is measured as `candidate`. A source
// root only needs a `src/` tree (for example a `git archive` of an older
// commit); the fixture always comes from this checkout.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const checkout = path.resolve(here, '..')
const esbuild = createRequire(path.join(checkout, 'package.json'))('esbuild')

const argv = process.argv.slice(2)
const option = (name) => {
	const index = argv.indexOf(name)
	return index < 0 ? undefined : argv[index + 1]
}
const runs = Number(option('--runs') ?? 15)
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('Invalid --runs')
const sources = argv.flatMap((arg, index) => (argv[index - 1] === '--source' ? [arg] : []))
if (sources.length === 0) sources.push(`candidate=${checkout}`)
const budgetPath = option('--check')
const receipt = option('--receipt')
const profile = option('--profile')
const variants = ['eager', 'getter']

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvx-app-load-'))
try {
	const cases = []
	for (const source of sources) {
		const split = source.indexOf('=')
		if (split < 1) throw new Error(`Expected label=root, got ${source}`)
		const label = source.slice(0, split)
		const root = path.resolve(source.slice(split + 1))
		if (!fs.existsSync(path.join(root, 'src'))) throw new Error(`No src/ under ${root}`)
		for (const variant of variants) {
			const out = path.join(dir, `${label}-${variant}.mjs`)
			await esbuild.build({
				absWorkingDir: checkout,
				entryPoints: [path.join(here, 'bench/app-module-load-entry.ts')],
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
					__CVX_BENCH_GETTERS__: String(variant === 'getter'),
				},
				logLevel: 'error',
				external: ['node:*'],
				plugins: [sourceRoot(root)],
			})
			cases.push({ name: `${label}-${variant}`, label, variant, out, samples: [] })
		}
	}

	const loader = path.join(dir, 'load.mjs')
	fs.writeFileSync(
		loader,
		`globalThis.gc()
const heap = process.memoryUsage().heapUsed
const start = performance.now()
const m = await import(process.argv[2])
const load = performance.now() - start
globalThis.gc()
const retainedMB = (process.memoryUsage().heapUsed - heap) / 1048576
const before = performance.now()
m.invoke()
const invoke = performance.now() - before
console.log(JSON.stringify({
	sample: { load, retainedMB, invoke, ...m.timings },
	functions: m.functionCount,
	snapshot: process.argv[3] === 'snapshot' ? m.snapshot() : undefined,
}))
`,
	)

	let expected
	for (let round = 0; round < runs; round++) {
		// Rotate the starting case each round to spread machine drift across cases.
		for (let offset = 0; offset < cases.length; offset++) {
			const item = cases[(round + offset) % cases.length]
			const { sample, snapshot, functions } = JSON.parse(
				execFileSync(
					process.execPath,
					['--expose-gc', '--no-warnings', loader, item.out, ...(round === 0 ? ['snapshot'] : [])],
					{ maxBuffer: 64 * 1024 * 1024 },
				).toString(),
			)
			item.samples.push(sample)
			item.functions = functions
			if (snapshot) {
				expected ??= snapshot
				assert.deepEqual(snapshot, expected, `Pushed function metadata differs: ${item.name}`)
			}
		}
	}

	if (profile) {
		fs.mkdirSync(profile, { recursive: true })
		for (const item of cases) {
			execFileSync(process.execPath, [
				'--expose-gc',
				'--cpu-prof',
				'--cpu-prof-interval',
				'25',
				`--cpu-prof-dir=${path.join(profile, item.name)}`,
				loader,
				item.out,
			])
			fs.copyFileSync(item.out, path.join(profile, `${item.name}.mjs`))
		}
	}

	const quantile = (values, p) =>
		[...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)]
	const results = cases.map(({ name, label, variant, functions, samples, out }) => ({
		name,
		label,
		variant,
		functions,
		bundleKB: Math.round(fs.statSync(out).size / 1024),
		samples,
		distribution: Object.fromEntries(
			Object.keys(samples[0]).map((key) => {
				const values = samples.map((sample) => sample[key])
				return [
					key,
					{
						p25: quantile(values, 0.25),
						median: quantile(values, 0.5),
						p75: quantile(values, 0.75),
					},
				]
			}),
		),
	}))
	if (receipt) {
		fs.mkdirSync(receipt, { recursive: true })
		fs.writeFileSync(
			path.join(receipt, 'app-load-results.json'),
			JSON.stringify({ node: process.version, runs, sources, results }, null, 2),
		)
	}
	console.table(
		Object.fromEntries(
			results.map(({ name, functions, bundleKB, distribution }) => [
				name,
				{
					functions,
					bundleKB,
					...Object.fromEntries(
						Object.entries(distribution).map(([key, value]) => [key, +value.median.toFixed(2)]),
					),
				},
			]),
		),
	)

	if (budgetPath) {
		// Budgets bound the medians of the last source (the candidate).
		const budget = JSON.parse(fs.readFileSync(budgetPath, 'utf8'))
		const candidate = results.filter((result) => result.label === results.at(-1).label)
		const failures = []
		for (const result of candidate) {
			for (const [metric, limit] of Object.entries(budget[result.variant] ?? {})) {
				const median = result.distribution[metric]?.median
				if (median === undefined) failures.push(`${result.name}: unknown metric ${metric}`)
				else if (median > limit)
					failures.push(`${result.name}: ${metric} median ${median.toFixed(2)} > budget ${limit}`)
			}
		}
		if (failures.length) {
			console.error(`Module-load budget exceeded:\n${failures.join('\n')}`)
			process.exitCode = 1
		} else console.log(`Module-load budget met (${budgetPath}).`)
	}
} finally {
	fs.rmSync(dir, { recursive: true, force: true })
}

/** Resolve the fixture's `../../src/*` imports against another source root. */
function sourceRoot(root) {
	return {
		name: 'cvx-source-root',
		setup(build) {
			build.onResolve({ filter: /^\.\.\/\.\.\/src\// }, async (args) => {
				if (path.dirname(args.importer) !== path.join(here, 'bench')) return undefined
				const target = path.join(root, args.path.slice('../../'.length))
				return build.resolve(`./${path.basename(target)}`, {
					kind: args.kind,
					resolveDir: path.dirname(target),
				})
			})
		},
	}
}
