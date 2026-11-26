#!/usr/bin/env node
// cvx-kit v2 codemod: rewrites the mechanical majority of Zod schema and kit
// table call sites to `k` and reports every site it left for manual work.
// Usage: node tools/codemod-v2/index.mjs <path…> [--write] [--report out.json]
//          [--ext ts,tsx,mts] [--ignore glob…]
// Without --write it is a dry run and writes nothing but the optional report.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, matchesGlob, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildReport, formatSummary } from './report.mjs'
import { transformSource } from './transform.mjs'

const SKIPPED_DIRECTORIES = new Set([
	'node_modules',
	'dist',
	'build',
	'.next',
	'_generated',
	'.git',
])

export function parseArguments(argv) {
	const options = {
		paths: [],
		write: false,
		report: null,
		extensions: ['ts', 'tsx', 'mts'],
		ignore: [],
	}
	let list = options.paths
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]
		if (arg === '--write') {
			options.write = true
			list = options.paths
		} else if (arg === '--report') {
			options.report = argv[++index]
			list = options.paths
		} else if (arg === '--ext') {
			options.extensions = argv[++index].split(',').map((ext) => ext.trim().replace(/^\./, ''))
			list = options.paths
		} else if (arg === '--ignore') {
			list = options.ignore
		} else if (arg.startsWith('--')) {
			throw new Error(`Unknown option ${arg}`)
		} else list.push(arg)
	}
	if (options.paths.length === 0) throw new Error('Pass at least one path')
	return options
}

export function collectFiles(options, cwd = process.cwd()) {
	const files = []
	const ignored = (path) => {
		const local = relative(cwd, path)
		return options.ignore.some((glob) => matchesGlob(local, glob) || matchesGlob(path, glob))
	}
	const accepts = (path) =>
		!path.endsWith('.d.ts') &&
		!/\.d\.[cm]ts$/.test(path) &&
		options.extensions.some((ext) => path.endsWith(`.${ext}`))
	const visit = (path) => {
		if (ignored(path)) return
		if (statSync(path).isDirectory()) {
			for (const entry of readdirSync(path, { withFileTypes: true })) {
				if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue
				visit(join(path, entry.name))
			}
		} else if (accepts(path)) files.push(path)
	}
	for (const path of options.paths) visit(resolve(cwd, path))
	return files.sort()
}

export function run(argv, cwd = process.cwd()) {
	const options = parseArguments(argv)
	const results = []
	for (const file of collectFiles(options, cwd)) {
		const source = readFileSync(file, 'utf8')
		const outcome = transformSource(relative(cwd, file), source)
		if (options.write && outcome.output !== source) writeFileSync(file, outcome.output)
		results.push(outcome)
	}
	const report = buildReport(results)
	if (options.report)
		writeFileSync(resolve(cwd, options.report), `${JSON.stringify(report, null, '\t')}\n`)
	return { report, summary: formatSummary(report, options.write) }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	try {
		console.log(run(process.argv.slice(2)).summary)
	} catch (error) {
		console.error(error.message)
		process.exit(1)
	}
}
