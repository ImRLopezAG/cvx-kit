// Usage: node scripts/bench-per-call.mjs [--runs N] [--source label=root ...]
//          [--scenario prefix ...] [--receipt DIR] [--no-alloc]
// Page scenarios use convex-test in one transaction per process; every call
// creates a fresh managed request. Registration scenarios invoke _handler.
// Allocation figures are sampled separately from timed warm calls.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const checkout = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const fixture = fileURLToPath(new URL('./bench/per-call-entry.ts', import.meta.url))
const esbuild = createRequire(import.meta.url)('esbuild')
let runs = 3
let profileAllocations = true
let receipt
const picks = []
const sources = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
	const flag = argv[i]
	if (flag === '--no-alloc') {
		profileAllocations = false
		continue
	}
	const value = argv[++i]
	if (!value || value.startsWith('--')) throw new Error(`Missing option value: ${flag}`)
	switch (flag) {
		case '--runs':
			runs = Number(value)
			break
		case '--receipt':
			receipt = path.resolve(value)
			break
		case '--source': {
			const split = value.indexOf('=')
			if (split <= 0 || split === value.length - 1) throw new Error('Expected --source label=root')
			sources.push({ label: value.slice(0, split), root: path.resolve(value.slice(split + 1)) })
			break
		}
		case '--scenario':
			picks.push(value)
			break
		default:
			throw new Error(`Unknown flag: ${flag}`)
	}
}
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('Invalid --runs')
if (!sources.length) sources.push({ label: 'candidate', root: checkout })
assert.equal(
	new Set(sources.map(({ label }) => label)).size,
	sources.length,
	'Use distinct source labels',
)
const scenarios = [
	...['authQuery', 'authMutation'].flatMap((kind) =>
		[1, 25, 100].flatMap((size) =>
			['bare', 'wrapper', 'args', 'result', 'both'].map((mode) => `${kind}/${mode}/${size}`),
		),
	),
	...[25, 100].flatMap((size) =>
		['zero', 'one', 'several', 'indexed', 'merge', 'relations', 'search'].map(
			(mode) => `page/${mode}/${size}`,
		),
	),
	'cursor/seal',
	'cursor/roundtrip',
	'plan/filter-scope',
	'effect/direct',
	'effect/query',
	'effect/command',
	'effect/command-folded',
]
const selected = scenarios.filter(
	(scenario) => !picks.length || picks.some((prefix) => scenario.startsWith(prefix)),
)
for (const pick of picks)
	assert(
		scenarios.some((scenario) => scenario.startsWith(pick)),
		`Unknown scenario prefix: ${pick}`,
	)

const scratch = mkdtempSync(path.join(os.tmpdir(), 'cvx-per-call-'))
const worker = fileURLToPath(new URL('./bench/per-call-worker.mjs', import.meta.url))
const resolveFromCheckout = createRequire(import.meta.url)

function redirect(root) {
	return {
		name: 'cvx-per-call-source',
		setup(build) {
			build.onResolve({ filter: /^[^./]/ }, (args) => {
				if (!args.importer.startsWith(path.join(root, 'src') + path.sep)) return undefined
				return build.resolve(args.path, { kind: args.kind, resolveDir: checkout })
			})
			build.onResolve({ filter: /^\.\.\/\.\.\/src\// }, (args) => {
				if (args.resolveDir !== path.dirname(fixture)) return undefined
				const target = path.join(root, args.path.slice('../../'.length))
				return build.resolve(`./${path.basename(target)}`, {
					kind: args.kind,
					resolveDir: path.dirname(target),
				})
			})
		},
	}
}

function provenance(root) {
	const git = (...args) => {
		try {
			return execFileSync('git', ['-C', root, ...args], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'ignore'],
			}).trim()
		} catch {
			return null
		}
	}
	// A source root can be a plain git archive.
	if (git('rev-parse', '--show-toplevel') !== root) return {}
	return {
		head: git('rev-parse', 'HEAD'),
		sourceChanges: git('status', '--porcelain', '--', 'src', 'package.json', 'bun.lock'),
	}
}

function summary(values) {
	const sorted = [...values].sort((a, b) => a - b)
	function percentile(p) {
		const position = (sorted.length - 1) * p
		const base = Math.floor(position)
		return sorted[base] + (sorted[Math.ceil(position)] - sorted[base]) * (position - base)
	}
	return { p25: percentile(0.25), median: percentile(0.5), p75: percentile(0.75) }
}

try {
	const results = []
	const dependencies = Object.fromEntries(
		['convex', 'convex-helpers', 'convex-test', 'effect', 'zod', '@noble/ciphers', 'esbuild'].map(
			(name) => [
				name,
				JSON.parse(readFileSync(path.join(checkout, 'node_modules', name, 'package.json'), 'utf8'))
					.version,
			],
		),
	)
	for (const [index, source] of sources.entries()) {
		Object.assign(source, provenance(source.root))
		const bundle = path.join(scratch, `source-${index}.mjs`)
		await esbuild.build({
			absWorkingDir: checkout,
			entryPoints: [fixture],
			bundle: true,
			platform: 'browser',
			format: 'esm',
			target: 'esnext',
			outfile: bundle,
			conditions: ['convex', 'module'],
			define: { 'process.env.NODE_ENV': '"production"' },
			minifySyntax: true,
			minifyIdentifiers: true,
			keepNames: true,
			logLevel: 'error',
			nodePaths: [path.join(checkout, 'node_modules')],
			// Run the harness in Node. Its SDK dependencies resolve normally and
			// fixture/library imports still follow Convex's bundling conditions.
			plugins: [
				redirect(source.root),
				{
					name: 'external-convex-test',
					setup(build) {
						build.onResolve({ filter: /^convex-test$/ }, () => ({
							path: resolveFromCheckout.resolve('convex-test'),
							external: true,
						}))
					},
				},
			],
		})
		source.bundleSha256 = createHash('sha256').update(readFileSync(bundle)).digest('hex')
		for (const scenario of selected)
			results.push({ source: source.label, scenario, bundle, samples: [] })
	}
	for (let round = 0; round < runs; round++) {
		for (let offset = 0; offset < results.length; offset++) {
			const entry = results[(offset + round) % results.length]
			entry.samples.push(
				JSON.parse(
					execFileSync(
						process.execPath,
						[
							'--expose-gc',
							worker,
							entry.bundle,
							entry.scenario,
							...(profileAllocations && round === 0 ? ['alloc'] : []),
						],
						{ encoding: 'utf8' },
					),
				),
			)
		}
	}
	for (const entry of results) {
		delete entry.bundle
		const { samples } = entry
		for (const sample of samples)
			assert.deepEqual(sample.counts, samples[0].counts, `Read counts drifted: ${entry.scenario}`)
		entry.counts = samples[0].counts
		entry.distribution = Object.fromEntries(
			['firstUs', 'warmUs'].map((key) => [key, summary(samples.map((sample) => sample[key]))]),
		)
		entry.warmSampledBytes = samples[0].warmSampledBytes
	}
	if (receipt) {
		mkdirSync(receipt, { recursive: true })
		writeFileSync(
			path.join(receipt, 'per-call-results.json'),
			JSON.stringify(
				{
					node: process.version,
					arch: os.arch(),
					platform: os.platform(),
					runs,
					dependencies,
					sources,
					results,
				},
				null,
				2,
			),
		)
	}
	const interval = ({ median, p25, p75 }) =>
		`${median.toFixed(1)} [${p25.toFixed(1)}, ${p75.toFixed(1)}]`
	console.table(
		Object.fromEntries(
			results.map((entry) => [
				`${entry.source}/${entry.scenario}`,
				{
					'first µs [p25, p75]': interval(entry.distribution.firstUs),
					'warm µs [p25, p75]': interval(entry.distribution.warmUs),
					'sampled B/warm call': entry.warmSampledBytes?.toFixed(0) ?? '—',
					get: entry.counts?.gets ?? '—',
					dup: entry.counts?.duplicateGets ?? '—',
					query: entry.counts?.queries ?? '—',
					rows: entry.counts?.rows ?? '—',
					policy: entry.counts?.policies ?? '—',
				},
			]),
		),
	)
} finally {
	rmSync(scratch, { recursive: true, force: true })
}
