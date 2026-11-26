// Validator-flavor benchmark: the same schemas written with classic Zod,
// zod/mini, plain Convex `v.*` and cvx-kit's `k`, bundled the way Convex does
// (browser, ESM, `convex,module` conditions) and imported in fresh processes.
// Reports bundle bytes by package, module eval time and retained heap for
// "declare only" and "declare + build native validators", and tsc type cost.
//
// Usage: node scripts/bench-validators.mjs [--runs N] [--schemas N] [--seed S]
//          [--descriptor path.json] [--json out.json] [--flavors a,b,c] [--skip-types]
// Without --descriptor a seeded synthetic workload is measured. A descriptor
// file is read in place and never copied into the checkout.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { validate } from './bench/validators/descriptor.mjs'
import { emit, flavors as allFlavors } from './bench/validators/emit.mjs'
import { synthetic } from './bench/validators/synthetic.mjs'
import { typecheck } from './bench/validators/typecheck.mjs'

const here = path.dirname(new URL(import.meta.url).pathname)
const checkout = path.resolve(here, '..')
const esbuild = createRequire(path.join(checkout, 'package.json'))('esbuild')
export const kEntry = path.join(checkout, 'src', 'k', 'index.ts')

/**
 * Bundles `source` (written to `<out>.ts`) to `out` like Convex does and
 * returns its size and the bytes each package contributes to it.
 */
export async function bundle(source, out) {
	const entry = `${out}.ts`
	fs.writeFileSync(entry, source)
	const result = await esbuild.build({
		absWorkingDir: checkout,
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
		define: { 'process.env.NODE_ENV': '"production"' },
		logLevel: 'silent',
		external: ['node:*'],
		metafile: true,
	})
	const bytes = fs.statSync(out).size
	const output = Object.values(result.metafile.outputs).find((item) => item.entryPoint)
	const packages = {}
	const realEntry = fs.realpathSync(entry)
	for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
		const owner = attribute(path.resolve(checkout, input), realEntry)
		packages[owner] = (packages[owner] ?? 0) + bytesInOutput
	}
	const attributed = Object.values(packages).reduce((sum, value) => sum + value, 0)
	// Module glue (export lists, ESM wrappers) belongs to no input.
	packages['(glue)'] = bytes - attributed
	return { bytes, packages }
}

/** The package, `k` or `schemas` (the generated module) that owns `file`. */
export function attribute(file, entry) {
	if (file === entry) return 'schemas'
	const match = /.*node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file)
	if (match) return match[1]
	if (file.startsWith(path.join(checkout, 'src', 'k') + path.sep)) return 'src/k'
	return 'other'
}

const loaderSource = `globalThis.gc()
const heap = process.memoryUsage().heapUsed
const start = performance.now()
const m = await import(process.argv[2])
const native = process.argv[3] === 'native' ? m.forceNative() : undefined
const ms = performance.now() - start
// Keep the namespace and native validators reachable while measuring.
globalThis.__cvxBenchKeep = [m, native]
globalThis.gc()
const retainedMB = (process.memoryUsage().heapUsed - heap) / 1048576
console.log(JSON.stringify({ ms, retainedMB }))
`

const median = (values) => [...values].sort((a, b) => a - b)[(values.length - 1) >> 1]

async function main() {
	const argv = process.argv.slice(2)
	const option = (name) => {
		const index = argv.indexOf(name)
		return index < 0 ? undefined : argv[index + 1]
	}
	const runs = Number(option('--runs') ?? 15)
	if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('Invalid --runs')
	const schemas = Number(option('--schemas') ?? 400)
	const seed = Number(option('--seed') ?? 1)
	const descriptorPath = option('--descriptor')
	const jsonPath = option('--json')
	const skipTypes = argv.includes('--skip-types')
	const flavors = (option('--flavors') ?? allFlavors.join(',')).split(',').filter(Boolean)
	for (const flavor of flavors)
		if (!allFlavors.includes(flavor)) throw new Error(`Unknown flavor ${flavor}`)

	const descriptor = descriptorPath
		? validate(JSON.parse(fs.readFileSync(path.resolve(descriptorPath), 'utf8')))
		: synthetic({ schemas, seed })
	const workload = descriptorPath
		? `descriptor ${path.basename(descriptorPath)}`
		: `synthetic schemas=${schemas} seed=${seed}`

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvx-validators-'))
	const results = {}
	try {
		const available = []
		for (const flavor of flavors) {
			if (flavor === 'k' && !fs.existsSync(kEntry)) {
				results[flavor] = {
					status: 'unavailable',
					reason: `${path.relative(checkout, kEntry)} not found`,
				}
				continue
			}
			const source = emit(descriptor, flavor, kEntry)
			const out = path.join(dir, `${flavor}.mjs`)
			try {
				results[flavor] = { status: 'ok', source, out, bundle: await bundle(source, out) }
				available.push(flavor)
			} catch (error) {
				const reason = error.errors?.[0]?.text ?? error.message
				results[flavor] = { status: 'unavailable', reason }
			}
		}

		const loader = path.join(dir, 'load.mjs')
		fs.writeFileSync(loader, loaderSource)
		const cases = available.flatMap((flavor) =>
			['declare', 'native'].map((mode) => ({ flavor, mode, samples: [] })),
		)
		for (let round = 0; round < runs; round++) {
			// Rotate the starting case each round to spread machine drift across cases.
			for (let offset = 0; offset < cases.length; offset++) {
				const item = cases[(round + offset) % cases.length]
				const bundlePath = pathToFileURL(results[item.flavor].out).href
				item.samples.push(
					JSON.parse(
						execFileSync(
							process.execPath,
							['--expose-gc', '--no-warnings', loader, bundlePath, item.mode],
							{
								maxBuffer: 64 * 1024 * 1024,
							},
						).toString(),
					),
				)
			}
		}
		for (const { flavor, mode, samples } of cases) {
			const result = results[flavor]
			result.samples = { ...result.samples, [mode]: samples }
			result.median = {
				...result.median,
				[`${mode}Ms`]: median(samples.map((sample) => sample.ms)),
				[`${mode}MB`]: median(samples.map((sample) => sample.retainedMB)),
			}
		}

		if (!skipTypes && available.length) {
			const types = typecheck(
				checkout,
				available.map((flavor) => [flavor, results[flavor].source]),
			)
			for (const flavor of available) results[flavor].types = types[flavor]
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}

	const kb = (bytes) => (bytes / 1024).toFixed(1)
	const fixed = (value, digits) => (value === undefined ? '-' : value.toFixed(digits))
	const typeCell = (result, key) => {
		if (skipTypes || !result.types) return '-'
		if (result.types.error) return 'error'
		return String(result.types[key])
	}
	const lines = [
		'| flavor | bundle KB | zod KB | declare ms | declare MB | +native ms | +native MB | Types | Instantiations |',
		'|---|---:|---:|---:|---:|---:|---:|---:|---:|',
	]
	for (const flavor of flavors) {
		const result = results[flavor]
		if (result.status !== 'ok') {
			lines.push(`| ${flavor} | unavailable | | | | | | | |`)
			continue
		}
		const { median: m, bundle: b } = result
		lines.push(
			`| ${flavor} | ${kb(b.bytes)} | ${kb(b.packages.zod ?? 0)} | ${fixed(m.declareMs, 2)} | ${fixed(m.declareMB, 2)} | ${fixed(m.nativeMs, 2)} | ${fixed(m.nativeMB, 2)} | ${typeCell(result, 'types')} | ${typeCell(result, 'instantiations')} |`,
		)
	}
	const measured = flavors.filter((flavor) => results[flavor].status === 'ok')
	const owners = [
		...new Set(measured.flatMap((flavor) => Object.keys(results[flavor].bundle.packages))),
	].sort()
	lines.push(
		'',
		`| bytes | ${measured.join(' | ')} |`,
		`|---|${measured.map(() => '---:').join('|')}|`,
	)
	for (const owner of owners)
		lines.push(
			`| ${owner} | ${measured.map((flavor) => results[flavor].bundle.packages[owner] ?? 0).join(' | ')} |`,
		)
	lines.push(`| total | ${measured.map((flavor) => results[flavor].bundle.bytes).join(' | ')} |`)
	const machine = `node ${process.version}, ${process.platform} ${process.arch}, runs=${runs}, ${workload}, schemas=${descriptor.schemas.length}, groups=${descriptor.groups?.length ?? 0}`
	lines.push('', machine)
	for (const flavor of flavors) {
		const result = results[flavor]
		if (result.status !== 'ok') lines.push(`${flavor}: unavailable (${result.reason})`)
		else if (result.types?.error) lines.push(`${flavor} type errors:\n${result.types.error}`)
	}
	console.log(lines.join('\n'))

	if (jsonPath) {
		const flavorsJson = Object.fromEntries(
			Object.entries(results).map(([flavor, { source: _source, out: _out, ...rest }]) => [
				flavor,
				rest,
			]),
		)
		fs.writeFileSync(
			path.resolve(jsonPath),
			JSON.stringify(
				{
					node: process.version,
					platform: process.platform,
					arch: process.arch,
					runs,
					workload,
					schemas: descriptor.schemas.length,
					groups: descriptor.groups?.length ?? 0,
					seed: descriptorPath ? undefined : seed,
					flavors: flavorsJson,
				},
				null,
				2,
			),
		)
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
	await main()
