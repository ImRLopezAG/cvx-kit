// Per-request module-load benchmark for a representative cvx-kit app, v1
// (Zod, commit 8d979a5) against v2 (`k`, this checkout). Bundles
// scripts/bench/app-module-load-entry.ts of each side the way Convex does
// (browser, ESM, `convex,module` conditions), then imports it in fresh
// processes and reports evaluation time, retained heap, phase timings and the
// cost of building one function's validators. Pushed function metadata must
// match across every source and variant, after the documented v1 to v2
// normalisations in `normalisedSnapshot`.
//
// Usage: node scripts/bench-app-load.mjs [--runs N] [--source label=root ...]
//          [--no-v1] [--types] [--check scripts/bench/app-load-budget.json]
//          [--receipt DIR] [--profile DIR]
// v1 is the source and fixture of commit 8d979a5, extracted with `git archive`
// (see scripts/bench/v1-source.mjs); it is skipped with a note when the commit
// is unavailable, with --no-v1, and with --check (budgets bound v2 only, so CI
// needs no history). Without --source, v2 is this checkout. A --source root
// only needs a `src/` tree; it is measured with this checkout's v2 fixture.
// --types also runs `tsc --extendedDiagnostics` on each side's fixture.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { attribute } from './bench-validators.mjs'
import { extractV1, V1_COMMIT, versionLine } from './bench/v1-source.mjs'

const here = path.dirname(new URL(import.meta.url).pathname)
const checkout = path.resolve(here, '..')
const esbuild = createRequire(path.join(checkout, 'package.json'))('esbuild')
const entryPath = path.join('scripts', 'bench', 'app-module-load-entry.ts')
export const variants = ['eager', 'getter']

/** Bundles one source's entry to `out` like Convex does; returns its size and bytes per owner. */
export async function buildApp({ root, fixtureRoot }, variant, out) {
	const entry = path.join(fixtureRoot, entryPath)
	const result = await esbuild.build({
		absWorkingDir: fixtureRoot,
		nodePaths: [path.join(checkout, 'node_modules')],
		entryPoints: [entry],
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
		metafile: true,
		plugins: root === fixtureRoot ? [] : [sourceRoot(fixtureRoot, root)],
	})
	const bytes = fs.statSync(out).size
	const output = Object.values(result.metafile.outputs).find((item) => item.entryPoint)
	const packages = {}
	for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
		const owner = ownerOf(fs.realpathSync(path.resolve(fixtureRoot, input)), [root, fixtureRoot])
		packages[owner] = (packages[owner] ?? 0) + bytesInOutput
	}
	const attributed = Object.values(packages).reduce((sum, value) => sum + value, 0)
	// Module glue (export lists, ESM wrappers) belongs to no input.
	packages['(glue)'] = bytes - attributed
	return { bytes, packages }
}

/** A package name, `cvx-kit` (any `src/` tree measured) or `fixture` (`scripts/bench`). */
export function ownerOf(file, roots) {
	const owner = attribute(file, undefined)
	if (owner !== 'other' && owner !== 'src/k') return owner
	for (const root of roots) {
		const real = fs.realpathSync(root)
		if (file.startsWith(path.join(real, 'src') + path.sep)) return 'cvx-kit'
		if (file.startsWith(path.join(real, 'scripts', 'bench') + path.sep)) return 'fixture'
	}
	return 'other'
}

/**
 * Pushed metadata with the documented v1 to v2 differences normalised. The
 * documented differences are: `tools.*` ids are `v.id` in v2 and `string` in
 * v1; the output side of `.optional().default()` is required in v2; update
 * shapes no longer fill defaults and filter failures use another error payload
 * (neither changes a validator). This app declares no tools and no
 * `.optional().default()` field, so none applies and the JSON is compared
 * unchanged; any difference is a finding, not something to normalise.
 */
export function normalisedSnapshot(snapshot) {
	return snapshot
}

const loaderSource = `globalThis.gc()
const heap = process.memoryUsage().heapUsed
const start = performance.now()
const m = await import(process.argv[2])
const load = performance.now() - start
globalThis.__cvxBenchKeep = m
globalThis.gc()
const retainedMB = (process.memoryUsage().heapUsed - heap) / 1048576
const before = performance.now()
m.invoke()
const invoke = performance.now() - before
// v1's entry names the table phase \`zodTables\`.
const { zodTables, ...timings } = m.timings
console.log(JSON.stringify({
	sample: { load, retainedMB, invoke, tables: timings.tables ?? zodTables, ...timings },
	functions: m.functionCount,
	snapshot: process.argv[3] === 'snapshot' ? m.snapshot() : undefined,
}))
`

/** Writes the child-process loader into `dir` and returns its path. */
export function writeLoader(dir) {
	const loader = path.join(dir, 'load.mjs')
	fs.writeFileSync(loader, loaderSource)
	return loader
}

/** One fresh child: load, retained heap, phases, invoke; with `snapshot`, the pushed metadata. */
export function runChild(loader, out, snapshot = false) {
	return JSON.parse(
		execFileSync(
			process.execPath,
			[
				'--expose-gc',
				'--no-warnings',
				loader,
				pathToFileURL(out).href,
				...(snapshot ? ['snapshot'] : []),
			],
			{ maxBuffer: 64 * 1024 * 1024 },
		).toString(),
	)
}

/** Throws unless `actual` pushes the same `exportArgs`/`exportReturns` JSON as `expected`. */
export function assertSameExports(expected, actual, label) {
	const left = normalisedSnapshot(expected)
	const right = normalisedSnapshot(actual)
	assert.deepEqual(Object.keys(right), Object.keys(left), `${label}: functions differ`)
	for (const key of Object.keys(left)) {
		assert.equal(right[key][0], left[key][0], `${label}: exportArgs() of ${key} differs`)
		assert.equal(right[key][1], left[key][1], `${label}: exportReturns() of ${key} differs`)
	}
}

/**
 * `tsc --extendedDiagnostics` on one side's entry and everything it imports,
 * from a temp tsconfig under node_modules/.cache (strict, bundler resolution,
 * skipLibCheck). Returns `{ types, instantiations, checkMs, files }` or `{ error }`.
 */
export function typecheckApp(fixtureRoot) {
	const cache = path.join(checkout, 'node_modules', '.cache')
	fs.mkdirSync(cache, { recursive: true })
	const dir = fs.mkdtempSync(path.join(cache, 'cvx-bench-app-types-'))
	const config = path.join(dir, 'tsconfig.json')
	try {
		fs.writeFileSync(
			config,
			JSON.stringify({
				compilerOptions: {
					target: 'ES2025',
					lib: ['ES2025', 'DOM'],
					module: 'ESNext',
					moduleResolution: 'bundler',
					strict: true,
					skipLibCheck: true,
					noEmit: true,
					isolatedModules: true,
					verbatimModuleSyntax: true,
					types: ['node'],
					typeRoots: [path.join(checkout, 'node_modules', '@types')],
				},
				files: [path.join(fixtureRoot, entryPath)],
			}),
		)
		let output
		let failed = false
		try {
			output = execFileSync(
				path.join(checkout, 'node_modules', '.bin', 'tsc'),
				['-p', config, '--extendedDiagnostics', '--pretty', 'false'],
				{ cwd: dir, maxBuffer: 64 * 1024 * 1024 },
			).toString()
		} catch (error) {
			failed = true
			output = `${error.stdout ?? ''}${error.stderr ?? ''}`
		}
		const errors = output.split('\n').filter((line) => /error TS\d+/.test(line))
		if (failed || errors.length)
			return { error: errors.slice(0, 10).join('\n') || output.slice(0, 2000) }
		const metric = (label) => {
			const match = new RegExp(`^${label}:\\s+([\\d.]+)`, 'm').exec(output)
			if (!match) throw new Error(`tsc did not report ${label}`)
			return Number(match[1])
		}
		return {
			files: metric('Files'),
			types: metric('Types'),
			instantiations: metric('Instantiations'),
			checkMs: Math.round(metric('Check time') * 1000),
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
}

/**
 * The v1 fixture at 8d979a5 was only ever bundled, never typechecked, and
 * has three type errors (a union of `.index` overloads is not callable, and the
 * `{ ...entities, payments, ledger }` spread drops the generated index
 * signature). These edits, applied to the extracted copy before `--types`
 * only, are the ones the v2 fixture carries; neither touches what a function
 * module evaluates (`appSchemaTables` is never called by the entry).
 */
export const v1TypePatches = [
	[
		'return { ...entities, payments, ledger }',
		'return Object.assign(entities, { payments, ledger })',
	],
	[
		`	return Object.fromEntries(
		Object.entries(tables).map(([name, boundary]) => [
			name,
			name === 'payments' || name === 'ledger'
				? boundary.table.index('by_type_entityId', ['type', 'entityId'])
				: boundary.table.index('by_parentId', ['parentId']).index('by_status', ['status']),
		]),
	)`,
		`	const { payments, ledger, ...entities } = tables
	return {
		...Object.fromEntries(
			Object.entries(entities).map(([name, boundary]) => [
				name,
				boundary.table.index('by_parentId', ['parentId']).index('by_status', ['status']),
			]),
		),
		payments: payments.table.index('by_type_entityId', ['type', 'entityId']),
		ledger: ledger.table.index('by_type_entityId', ['type', 'entityId']),
	}`,
	],
]

/** Applies `v1TypePatches` to the extracted v1 fixture under `root`; throws if one no longer matches. */
export function patchV1ForTypes(root) {
	const file = path.join(root, 'scripts', 'bench', 'app-fixture.ts')
	let text = fs.readFileSync(file, 'utf8')
	for (const [from, to] of v1TypePatches) {
		if (!text.includes(from))
			throw new Error(`v1 type patch no longer matches: ${from.split('\n')[0]}`)
		text = text.replace(from, to)
	}
	fs.writeFileSync(file, text)
}

/** Resolve the v2 fixture's `../../src/*` imports against another source root. */
function sourceRoot(fixtureRoot, root) {
	const benchDir = path.join(fixtureRoot, 'scripts', 'bench')
	return {
		name: 'cvx-source-root',
		setup(build) {
			build.onResolve({ filter: /^\.\.\/\.\.\/src\// }, async (args) => {
				if (path.dirname(args.importer) !== benchDir) return undefined
				const target = path.join(root, args.path.slice('../../'.length))
				return build.resolve(`./${path.basename(target)}`, {
					kind: args.kind,
					resolveDir: path.dirname(target),
				})
			})
		},
	}
}

const quantile = (values, p) =>
	[...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)]

async function main() {
	const argv = process.argv.slice(2)
	const option = (name) => {
		const index = argv.indexOf(name)
		return index < 0 ? undefined : argv[index + 1]
	}
	const runs = Number(option('--runs') ?? 15)
	if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('Invalid --runs')
	const budgetPath = option('--check')
	const receipt = option('--receipt')
	const profile = option('--profile')
	const types = argv.includes('--types')
	const withV1 = !budgetPath && !argv.includes('--no-v1')
	const explicit = argv.flatMap((arg, index) => (argv[index - 1] === '--source' ? [arg] : []))

	const notes = []
	const sources = []
	let v1
	if (withV1) {
		v1 = extractV1(['src', 'scripts/bench'])
		if (v1.reason) notes.push(`v1 rows skipped: ${v1.reason}.`)
		else sources.push({ label: 'v1', root: v1.root, fixtureRoot: v1.root })
	} else if (budgetPath) notes.push('v1 not measured: --check bounds v2 only.')
	if (explicit.length === 0) sources.push({ label: 'v2', root: checkout, fixtureRoot: checkout })
	for (const source of explicit) {
		const split = source.indexOf('=')
		if (split < 1) throw new Error(`Expected label=root, got ${source}`)
		const root = path.resolve(source.slice(split + 1))
		if (!fs.existsSync(path.join(root, 'src'))) throw new Error(`No src/ under ${root}`)
		sources.push({ label: source.slice(0, split), root, fixtureRoot: checkout })
	}

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvx-app-load-'))
	let results
	const typeResults = {}
	try {
		const cases = []
		for (const source of sources)
			for (const variant of variants) {
				const out = path.join(dir, `${source.label}-${variant}.mjs`)
				const bundle = await buildApp(source, variant, out)
				cases.push({
					name: `${source.label}-${variant}`,
					...source,
					variant,
					out,
					bundle,
					samples: [],
				})
			}
		const loader = writeLoader(dir)

		let expected
		let reference
		for (let round = 0; round < runs; round++) {
			// Rotate the starting case each round to spread machine drift across cases.
			for (let offset = 0; offset < cases.length; offset++) {
				const item = cases[(round + offset) % cases.length]
				const { sample, snapshot, functions } = runChild(loader, item.out, round === 0)
				item.samples.push(sample)
				item.functions = functions
				if (snapshot) {
					expected ??= snapshot
					reference ??= item.name
					assertSameExports(expected, snapshot, `${item.name} against ${reference}`)
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
					pathToFileURL(item.out).href,
				])
				fs.copyFileSync(item.out, path.join(profile, `${item.name}.mjs`))
			}
		}

		if (types)
			for (const source of sources) {
				if (source.root !== source.fixtureRoot) {
					notes.push(`${source.label}: --types skipped (its src/ is not beside a fixture).`)
					continue
				}
				if (source.label === 'v1') {
					patchV1ForTypes(source.root)
					notes.push(
						'v1 types: measured with the type-only fixture edits in v1TypePatches (the v1 fixture has 3 type errors as recorded).',
					)
				}
				typeResults[source.label] = typecheckApp(source.root)
			}

		results = cases.map(({ name, label, variant, functions, samples, bundle }) => ({
			name,
			label,
			variant,
			functions,
			bundle,
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
		if (expected && cases.length > 1)
			notes.push(
				`Parity: exportArgs()/exportReturns() JSON of all ${cases[0].functions} functions is identical across ${cases.length} cases (${cases.map((item) => item.name).join(', ')}).`,
			)
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
		v1?.cleanup?.()
	}

	if (receipt) {
		fs.mkdirSync(receipt, { recursive: true })
		fs.writeFileSync(
			path.join(receipt, 'app-load-results.json'),
			JSON.stringify(
				{
					node: process.version,
					runs,
					sources: sources.map(({ label }) => label),
					results,
					types: typeResults,
				},
				null,
				2,
			),
		)
	}

	const kb = (bytes) => (bytes / 1024).toFixed(1)
	const med = (result, key) => result.distribution[key]?.median
	const lines = [
		'| case | functions | bundle KB | zod KB | load ms | retained MB | tables ms | defineRelations ms | contractsAndAuth ms | registration ms | invoke ms |',
		'|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
	]
	for (const result of results)
		lines.push(
			`| ${result.name} | ${result.functions} | ${kb(result.bundle.bytes)} | ${kb(result.bundle.packages.zod ?? 0)} | ${med(result, 'load').toFixed(2)} | ${med(result, 'retainedMB').toFixed(2)} | ${med(result, 'tables').toFixed(2)} | ${med(result, 'defineRelations').toFixed(2)} | ${med(result, 'contractsAndAuth').toFixed(2)} | ${med(result, 'registration').toFixed(2)} | ${med(result, 'invoke').toFixed(2)} |`,
		)
	const owners = ['zod', 'convex', 'convex-helpers', 'cvx-kit', 'fixture']
	for (const owner of new Set(results.flatMap((result) => Object.keys(result.bundle.packages))))
		if (!owners.includes(owner)) owners.push(owner)
	lines.push(
		'',
		`| bytes | ${results.map((result) => result.name).join(' | ')} |`,
		`|---|${results.map(() => '---:').join('|')}|`,
	)
	for (const owner of owners)
		lines.push(
			`| ${owner} | ${results.map((result) => result.bundle.packages[owner] ?? 0).join(' | ')} |`,
		)
	lines.push(`| total | ${results.map((result) => result.bundle.bytes).join(' | ')} |`)

	const percent = (from, to) => `${(((to - from) / from) * 100).toFixed(1)}%`
	const find = (name) => results.find((result) => result.name === name)
	const comparisons = []
	for (const variant of variants) {
		const before = find(`v1-${variant}`)
		if (!before) continue
		for (const after of results.filter((r) => r.variant === variant && r.label !== 'v1'))
			comparisons.push(
				`${after.name} vs ${before.name}: load ms ${percent(med(before, 'load'), med(after, 'load'))}, retained MB ${percent(med(before, 'retainedMB'), med(after, 'retainedMB'))}, bundle KB ${percent(before.bundle.bytes, after.bundle.bytes)}, invoke ms ${percent(med(before, 'invoke'), med(after, 'invoke'))}`,
			)
	}
	if (comparisons.length) lines.push('', ...comparisons)

	if (types) {
		lines.push(
			'',
			'| types | files | Types | Instantiations | Check ms |',
			'|---|---:|---:|---:|---:|',
		)
		for (const [label, result] of Object.entries(typeResults))
			lines.push(
				result.error
					? `| ${label} | error | | | |`
					: `| ${label} | ${result.files} | ${result.types} | ${result.instantiations} | ${result.checkMs} |`,
			)
		for (const [label, result] of Object.entries(typeResults))
			if (result.error) lines.push(`${label} type errors:\n${result.error}`)
	}

	lines.push(
		'',
		...notes,
		`v1 = commit ${V1_COMMIT}; node ${process.version}, ${process.platform} ${process.arch}, ${os.cpus()[0]?.model ?? 'unknown cpu'}, runs=${runs}; ${versionLine()}`,
	)
	console.log(lines.join('\n'))

	if (budgetPath) {
		const budget = JSON.parse(fs.readFileSync(budgetPath, 'utf8'))
		const failures = []
		for (const result of results.filter((r) => r.label !== 'v1')) {
			for (const [metric, limit] of Object.entries(budget[result.variant] ?? {})) {
				const median =
					metric === 'bundleKB' ? result.bundle.bytes / 1024 : result.distribution[metric]?.median
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
	await main()
