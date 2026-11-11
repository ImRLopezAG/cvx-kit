// Measure a consumer app's Convex entry bundles against this checkout's dist
// without touching the consumer's node_modules.
//
// Usage: node scripts/bench-consumer.mjs <consumer-convex-dir> <entry.ts ...>
//          [--runs N] [--installed] [--keep DIR]
// Each entry is bundled like Convex does (browser, ESM). By default every
// `cvx-kit` / `cvx-kit/<subpath>` import resolves to this checkout's dist
// through its package.json export map, while the dist's own bare imports
// (zod, convex, ...) resolve from the consumer's installed cvx-kit, so only
// cvx-kit's code changes. `--installed` measures the consumer's installed
// cvx-kit instead. Run `bun run build` first. Env vars the consumer reads at
// module scope must be set by the caller.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const checkout = path.resolve(here, '..')
const esbuild = createRequire(path.join(checkout, 'package.json'))('esbuild')
const manifest = JSON.parse(fs.readFileSync(path.join(checkout, 'package.json'), 'utf8'))

const argv = process.argv.slice(2)
const option = (name) => {
	const index = argv.indexOf(name)
	return index < 0 ? undefined : argv[index + 1]
}
const flags = new Set(['--runs', '--keep'])
const positional = argv.filter((arg, index) => !arg.startsWith('--') && !flags.has(argv[index - 1]))
const [consumer, ...entries] = positional
if (!consumer || entries.length === 0) throw new Error('Provide a consumer directory and entries')
const runs = Number(option('--runs') ?? 9)
const installed = argv.includes('--installed')
const keep = option('--keep')
const root = path.resolve(consumer)
const consumerRequire = createRequire(path.join(root, 'package.json'))
const installedDir = path.dirname(consumerRequire.resolve('cvx-kit/package.json'))
const dist = path.join(checkout, 'dist')
if (!installed && !fs.existsSync(dist)) throw new Error('Run `bun run build` first')

const dir = keep ? path.resolve(keep) : fs.mkdtempSync(path.join(os.tmpdir(), 'cvx-consumer-'))
fs.mkdirSync(dir, { recursive: true })
const loader = path.join(dir, 'load.mjs')
fs.writeFileSync(
	loader,
	`globalThis.gc()
const heap = process.memoryUsage().heapUsed
const start = performance.now()
await import(process.argv[2])
const load = performance.now() - start
globalThis.gc()
console.log(JSON.stringify({ load, retainedMB: (process.memoryUsage().heapUsed - heap) / 1048576 }))
`,
)
try {
	const rows = {}
	for (const entry of entries) {
		const out = path.join(dir, `${path.basename(entry, path.extname(entry))}.mjs`)
		await esbuild.build({
			absWorkingDir: root,
			entryPoints: [path.resolve(root, entry)],
			bundle: true,
			platform: 'browser',
			format: 'esm',
			target: 'esnext',
			outfile: out,
			conditions: ['convex', 'module'],
			logLevel: 'error',
			external: ['node:*'],
			plugins: installed ? [] : [localDist()],
		})
		const samples = Array.from({ length: runs }, () =>
			JSON.parse(
				execFileSync(process.execPath, ['--expose-gc', '--no-warnings', loader, out]).toString(),
			),
		)
		const median = (key) =>
			samples.map((sample) => sample[key]).sort((a, b) => a - b)[(runs - 1) >> 1]
		rows[entry] = {
			cvxKit: installed ? 'installed' : 'local dist',
			bundleKB: Math.round(fs.statSync(out).size / 1024),
			loadMs: +median('load').toFixed(1),
			retainedMB: +median('retainedMB').toFixed(1),
		}
	}
	console.table(rows)
} finally {
	if (!keep) fs.rmSync(dir, { recursive: true, force: true })
}

function localDist() {
	const exportTarget = (subpath) => {
		const target = manifest.exports[subpath]
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Export-map entries are either a path or a conditions object.
		const file = typeof target === 'string' ? target : (target?.import ?? target?.default)
		if (!file) throw new Error(`cvx-kit has no export ${subpath}`)
		return path.join(checkout, file)
	}
	return {
		name: 'cvx-kit-local-dist',
		setup(build) {
			build.onResolve({ filter: /^cvx-kit(\/.*)?$/ }, (args) => ({
				path: exportTarget(args.path === 'cvx-kit' ? '.' : `.${args.path.slice('cvx-kit'.length)}`),
			}))
			// The dist's own dependencies come from the consumer's installed copy.
			build.onResolve({ filter: /^[^./]/ }, (args) => {
				if (!args.importer.startsWith(dist + path.sep) || args.pluginData?.redirected)
					return undefined
				return build.resolve(args.path, {
					kind: args.kind,
					resolveDir: installedDir,
					pluginData: { redirected: true },
				})
			})
		},
	}
}
