// Bundles the registration benchmark like Convex 1.48 does, then reports the
// median of cold jitless loads.
// Usage: node scripts/bench-relations.mjs [repoRoot] [runs] [entry: relations | relations-page]
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? '.')
const runs = Number(process.argv[3] ?? 7)
const entry = process.argv[4] ?? 'relations'
const here = path.dirname(new URL(import.meta.url).pathname)
const esbuild = createRequire(path.join(here, '..', 'package.json'))('esbuild')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvx-bench-'))
const out = path.join(dir, 'relations.mjs')
await esbuild.build({
	absWorkingDir: root,
	entryPoints: [path.join(root, `scripts/bench/${entry}-entry.ts`)],
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
	logLevel: 'error',
	external: ['node:*'],
})
const loader = path.join(dir, 'load.mjs')
fs.writeFileSync(
	loader,
	`const t = performance.now()\nconst m = await import(process.argv[2])\nconsole.log(JSON.stringify({ load: performance.now() - t, ...m.timings }))\n`,
)
const samples = []
for (let i = 0; i < runs; i++)
	samples.push(JSON.parse(execFileSync('node', ['--jitless', '--no-warnings', loader, out]).toString()))
const median = (key) => {
	const values = samples.map((sample) => sample[key]).sort((a, b) => a - b)
	return values[Math.floor(values.length / 2)]
}
const result = Object.fromEntries(
	Object.keys(samples[0]).map((key) => [key, Math.round(median(key) * 10) / 10]),
)
console.log(JSON.stringify(result))
fs.rmSync(dir, { recursive: true, force: true })
