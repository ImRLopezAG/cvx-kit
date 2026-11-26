// Whole-request benchmark, v1 (Zod) against v2 (`k`), restricted to what
// exists on both sides: ~30 table boundaries, the auth builders and one
// function module registering five operations of one domain. Relations, the
// query engine and domain contracts are not on `k` yet and are left out.
//
// Each case is bundled the way Convex does (browser, ESM, `convex,module`
// conditions) and imported in fresh `node --expose-gc` processes. Reports
// bundle bytes by owner, module load, retained heap, phase timings, the cost
// of exporting every function's validators (deploy analysis) and of calling
// `create` through Convex's `invokeMutation` hook. Pushed `exportArgs` and
// `exportReturns` JSON must be identical across every case.
//
// Usage: node scripts/bench-request.mjs [--runs N] [--json out.json]
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname)
const checkout = path.resolve(here, '..')
const esbuild = createRequire(path.join(checkout, 'package.json'))('esbuild')
const fixtureDir = path.join(here, 'bench', 'request')
const authFile = path.join(checkout, 'src', 'auth.ts')

/** Measured cases. `projected` stubs the v1 modules `src/auth.ts` still imports. */
export const caseList = [
	{ name: 'v1 eager', side: 'v1', variant: 'eager', projected: false },
	{ name: 'v1 getter', side: 'v1', variant: 'getter', projected: false },
	{ name: 'v2 eager', side: 'v2', variant: 'eager', projected: false },
	{ name: 'v2 getter', side: 'v2', variant: 'getter', projected: false },
	{ name: 'v2 projected eager', side: 'v2', variant: 'eager', projected: true },
	{ name: 'v2 projected getter', side: 'v2', variant: 'getter', projected: true },
]

/** Bundles one case to `out` like Convex does; returns its size and bytes per owner. */
export async function buildCase(item, out) {
	const result = await esbuild.build({
		absWorkingDir: checkout,
		entryPoints: [path.join(fixtureDir, `${item.side}-entry.ts`)],
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
			__CVX_BENCH_GETTERS__: String(item.variant === 'getter'),
		},
		logLevel: 'error',
		external: ['node:*'],
		metafile: true,
		plugins: item.projected ? [withoutV1AuthImports()] : [],
	})
	const bytes = fs.statSync(out).size
	const output = Object.values(result.metafile.outputs).find((entry) => entry.entryPoint)
	const packages = {}
	const files = {}
	for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
		const owner = owns(input)
		packages[owner] = (packages[owner] ?? 0) + bytesInOutput
		files[input] = bytesInOutput
	}
	const attributed = Object.values(packages).reduce((sum, value) => sum + value, 0)
	// Module glue (export lists, ESM wrappers) belongs to no input.
	packages['(glue)'] = bytes - attributed
	return { bytes, packages, files }
}

/** Owner of one metafile input: a package, `src/k`, the rest of `src`, or the fixture. */
export function owns(input) {
	if (input.startsWith('stub:')) return '(stub)'
	const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input)
	if (match) return match[1]
	const file = path.resolve(checkout, input)
	if (file.startsWith(fixtureDir + path.sep)) return 'fixture'
	if (file === path.join(checkout, 'src', 'k.ts')) return 'src/k'
	if (file.startsWith(path.join(checkout, 'src', 'k') + path.sep)) return 'src/k'
	if (file.startsWith(path.join(checkout, 'src') + path.sep)) return 'src (rest)'
	return 'other'
}

/**
 * Replaces the v1 imports of `src/auth.ts` (`zod` and `./zod-registration`; the
 * `convex-helpers/server/zod4` import is type-only) with stubs that throw when
 * used, so any v1 code the v2 path still reaches fails loudly.
 */
function withoutV1AuthImports() {
	const stubs = {
		zod: 'export const z = new Proxy({}, { get() { throw new Error("zod is stubbed out") } })',
		'./zod-registration':
			'const stubbed = () => { throw new Error("zod-registration is stubbed out") }\n' +
			'export const rawFunctionArgs = stubbed, zCustomAction = stubbed, zCustomMutation = stubbed, zCustomQuery = stubbed',
	}
	return {
		name: 'cvx-without-v1-auth-imports',
		setup(build) {
			build.onResolve({ filter: /^(zod|\.\/zod-registration)$/ }, (args) =>
				args.importer === authFile ? { path: args.path, namespace: 'stub' } : undefined,
			)
			build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
				contents: stubs[args.path],
				loader: 'js',
			}))
		},
	}
}

/** Valid JSON args for each operation, as the Convex client would send them. */
const calls = {
	create: [
		'mutation',
		{ title: 'Quarterly report', status: 'open', ref: 'R-1', amountCents: 1250 },
	],
	update: ['mutation', { id: 'k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r', patch: { title: 'Renamed' } }],
	get: ['query', { id: 'k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r' }],
	list: ['query', { status: 'open', limit: 10 }],
	archive: ['mutation', { id: 'k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r' }],
}
const warmCalls = 200

const loaderSource = `// Stand-in for the Convex isolate: auth resolves to one member identity.
const identity = { subject: 'user_1', issuer: 'bench', tokenIdentifier: 'bench|user_1', org_id: 'org_1', role: 'member' }
globalThis.Convex = {
	syscall: (op) => { throw new Error('Unexpected syscall ' + op) },
	asyncSyscall: async (op) => {
		if (op === '1.0/getUserIdentity') return JSON.stringify(identity)
		throw new Error('Unexpected syscall ' + op)
	},
}
const calls = ${JSON.stringify(calls)}
const invoke = (fn, kind, args) =>
	kind === 'mutation' ? fn.invokeMutation(JSON.stringify([args])) : fn.invokeQuery(JSON.stringify([args]))
const exportAll = (functions) =>
	Object.fromEntries(Object.entries(functions).map(([key, fn]) => [key, [fn.exportArgs(), fn.exportReturns()]]))
const mode = process.argv[3]
globalThis.gc()
const heap = process.memoryUsage().heapUsed
const start = performance.now()
const m = await import(process.argv[2])
const load = performance.now() - start
// Keep the namespace reachable while measuring retained heap.
globalThis.__cvxBenchKeep = m
globalThis.gc()
const retainedMB = (process.memoryUsage().heapUsed - heap) / 1048576
if (mode === 'request') {
	const [kind, args] = calls.create
	let before = performance.now()
	await invoke(m.functions.create, kind, args)
	const firstCall = performance.now() - before
	before = performance.now()
	for (let i = 0; i < ${warmCalls}; i++) await invoke(m.functions.create, kind, args)
	const warmCallUs = ((performance.now() - before) / ${warmCalls}) * 1000
	console.log(JSON.stringify({ load, retainedMB, ...m.timings, firstCall, warmCallUs }))
} else if (mode === 'export') {
	const before = performance.now()
	exportAll(m.functions)
	console.log(JSON.stringify({ exportMs: performance.now() - before }))
} else {
	const results = {}
	for (const [name, [kind, args]] of Object.entries(calls))
		results[name] = JSON.parse(await invoke(m.functions[name], kind, args))
	let rejected = false
	try {
		await invoke(m.functions.create, 'mutation', { ...calls.create[1], title: '' })
	} catch {
		rejected = true
	}
	console.log(JSON.stringify({ snapshot: exportAll(m.functions), results, rejected }))
}
`

/** Writes the child-process loader into `dir` and returns its path. */
export function writeLoader(dir) {
	const loader = path.join(dir, 'load.mjs')
	fs.writeFileSync(loader, loaderSource)
	return loader
}

/** Runs one fresh child: `check` (exports, calls, a rejected call), `request` or `export`. */
export function runChild(loader, out, mode) {
	return JSON.parse(
		execFileSync(
			process.execPath,
			['--expose-gc', '--no-warnings', loader, pathToFileURL(out).href, mode],
			{ maxBuffer: 64 * 1024 * 1024 },
		).toString(),
	)
}

/**
 * Pushed metadata with the documented v1 to v2 differences normalised. None
 * applies to this fixture: it declares no `tools.*` ids and no
 * `.optional().default()` field, so the JSON is compared unchanged.
 */
export function normalisedSnapshot(snapshot) {
	return snapshot
}

/** Throws unless `actual` pushes the same function metadata and call results as `expected`. */
export function assertParity(expected, actual, label) {
	for (const key of Object.keys(expected.snapshot)) {
		const [args, returns] = normalisedSnapshot(expected.snapshot)[key]
		const [actualArgs, actualReturns] = normalisedSnapshot(actual.snapshot)[key] ?? []
		assert.equal(actualArgs, args, `${label}: exportArgs() of ${key} differs`)
		assert.equal(actualReturns, returns, `${label}: exportReturns() of ${key} differs`)
	}
	assert.deepEqual(
		Object.keys(actual.snapshot),
		Object.keys(expected.snapshot),
		`${label}: functions differ`,
	)
	assert.deepEqual(actual.results, expected.results, `${label}: call results differ`)
	assert.equal(actual.rejected, true, `${label}: create accepted a title that fails min(1)`)
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
	const jsonPath = option('--json')

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvx-request-'))
	const notes = []
	let cases
	try {
		cases = []
		for (const item of caseList) {
			const out = path.join(dir, `${item.name.replaceAll(' ', '-')}.mjs`)
			cases.push({ ...item, out, bundle: await buildCase(item, out), samples: [] })
		}
		const loader = writeLoader(dir)

		// Parity: every real case must match v1 eager exactly. A projected case that
		// does not match is dropped from the report rather than failing the run.
		const reference = runChild(loader, cases[0].out, 'check')
		const failed = new Set()
		for (const item of cases.slice(1)) {
			try {
				assertParity(reference, runChild(loader, item.out, 'check'), item.name)
			} catch (error) {
				if (!item.projected) throw error
				notes.push(`${item.name}: not reported (${error.message.split('\n')[0]})`)
				failed.add(item)
			}
		}
		cases = cases.filter((item) => !failed.has(item))

		for (let round = 0; round < runs; round++) {
			// Rotate the starting case each round to spread machine drift across cases.
			for (let offset = 0; offset < cases.length; offset++) {
				const item = cases[(round + offset) % cases.length]
				item.samples.push({
					...runChild(loader, item.out, 'request'),
					...runChild(loader, item.out, 'export'),
				})
			}
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}

	for (const item of cases)
		item.median = Object.fromEntries(
			Object.keys(item.samples[0]).map((key) => [
				key,
				quantile(
					item.samples.map((sample) => sample[key]),
					0.5,
				),
			]),
		)

	const kb = (bytes) => (bytes / 1024).toFixed(1)
	const lines = [
		'| case | bundle KB | zod KB | load ms | retained MB | tables ms | auth ms | registration ms | export ms | first-call ms | warm-call µs |',
		'|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
	]
	for (const { name, bundle: b, median: m } of cases)
		lines.push(
			`| ${name} | ${kb(b.bytes)} | ${kb(b.packages.zod ?? 0)} | ${m.load.toFixed(2)} | ${m.retainedMB.toFixed(2)} | ${m.tables.toFixed(2)} | ${m.auth.toFixed(2)} | ${m.registration.toFixed(2)} | ${m.exportMs.toFixed(2)} | ${m.firstCall.toFixed(2)} | ${m.warmCallUs.toFixed(1)} |`,
		)
	const owners = [...new Set(cases.flatMap((item) => Object.keys(item.bundle.packages)))].sort()
	lines.push(
		'',
		`| bytes | ${cases.map((item) => item.name).join(' | ')} |`,
		`|---|${cases.map(() => '---:').join('|')}|`,
	)
	for (const owner of owners)
		lines.push(
			`| ${owner} | ${cases.map((item) => item.bundle.packages[owner] ?? 0).join(' | ')} |`,
		)
	lines.push(`| total | ${cases.map((item) => item.bundle.bytes).join(' | ')} |`, '')

	const percent = (from, to) => `${(((to - from) / from) * 100).toFixed(1)}%`
	const find = (name) => cases.find((item) => item.name === name)
	for (const variant of ['eager', 'getter'])
		for (const name of [`v2 ${variant}`, `v2 projected ${variant}`]) {
			const v1 = find(`v1 ${variant}`)
			const v2 = find(name)
			if (!v2) continue
			lines.push(
				`${name} vs v1 ${variant}: load ms ${percent(v1.median.load, v2.median.load)}, retained MB ${percent(v1.median.retainedMB, v2.median.retainedMB)}, bundle KB ${percent(v1.bundle.bytes, v2.bundle.bytes)}`,
			)
		}

	const real = find('v2 eager')
	const projected = find('v2 projected eager')
	if (projected) {
		const carried = owners
			.map((owner) => [
				owner,
				(real.bundle.packages[owner] ?? 0) - (projected.bundle.packages[owner] ?? 0),
			])
			.filter(([owner, bytes]) => bytes !== 0 && owner !== '(stub)')
			.map(([owner, bytes]) => `${owner} ${kb(bytes)} KB`)
		lines.push(
			'',
			`Carried by src/auth.ts's v1 imports in the v2 bundle (v2 eager minus v2 projected eager): ${carried.join(', ')}`,
		)
	}
	lines.push(
		'',
		`Parity: exportArgs()/exportReturns() JSON of all 5 functions, call results and the rejected invalid call match across ${cases.length} cases.`,
		...notes,
		`node ${process.version}, ${process.platform} ${process.arch}, ${os.cpus()[0]?.model ?? 'unknown cpu'}, runs=${runs}, warm calls=${warmCalls}`,
	)
	console.log(lines.join('\n'))

	if (jsonPath)
		fs.writeFileSync(
			path.resolve(jsonPath),
			JSON.stringify(
				{
					node: process.version,
					platform: process.platform,
					arch: process.arch,
					cpu: os.cpus()[0]?.model,
					runs,
					warmCalls,
					notes,
					cases: cases.map(({ name, side, variant, projected, bundle, samples, median }) => ({
						name,
						side,
						variant,
						projected,
						bundle: { bytes: bundle.bytes, packages: bundle.packages },
						samples,
						median,
					})),
				},
				null,
				2,
			),
		)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
	await main()
