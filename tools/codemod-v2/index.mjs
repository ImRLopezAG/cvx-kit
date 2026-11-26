#!/usr/bin/env node
// cvx-kit v2 codemod: rewrites the mechanical majority of Zod schema and kit
// table call sites to `k` and reports every site it left for manual work.
// Usage: cvx-kit-codemod-v2 <path…> [--write] [--report out.json]
//          [--ext ts,tsx,mts] [--no-getters] [--no-strip-parsed] [--ignore glob…]
// --no-getters keeps function `args` / `returns` as data properties.
// --no-strip-parsed leaves parsed object schemas strict instead of adding `.strip()`.
// Without --write it is a dry run and writes nothing but the optional report.
//
// The run reads every file twice: the first pass records what each file exports
// as `k`, imports and parses; the second rewrites with that knowledge, so a
// type helper on an imported schema and a schema parsed in another file are
// judged by the whole run, not one file.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, matchesGlob, relative, resolve } from 'node:path'
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
		getters: true,
		stripParsed: true,
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
		} else if (arg === '--no-getters') {
			options.getters = false
			list = options.paths
		} else if (arg === '--no-strip-parsed') {
			options.stripParsed = false
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
	const files = collectFiles(options, cwd).map((file) => ({
		file,
		path: relative(cwd, file),
		source: readFileSync(file, 'utf8'),
	}))
	const transformOptions = { getters: options.getters, stripParsed: options.stripParsed }
	const first = files.map(({ path, source }) => transformSource(path, source, transformOptions))
	const knowledge = runKnowledge(files, first, cwd)
	const results = []
	for (const { file, path, source } of files) {
		const outcome = transformSource(path, source, { ...transformOptions, run: knowledge })
		if (options.write && outcome.output !== source) writeFileSync(file, outcome.output)
		results.push(outcome)
	}
	const report = buildReport(results)
	if (options.report)
		writeFileSync(resolve(cwd, options.report), `${JSON.stringify(report, null, '\t')}\n`)
	return { report, summary: formatSummary(report, options.write) }
}

const RESOLVED_EXTENSIONS = ['', '.ts', '.tsx', '.mts', '/index.ts', '/index.tsx', '/index.mts']

/** Resolve a relative import specifier to a file of the run, by its run-relative path. */
function resolver(files, cwd) {
	const known = new Set(files.map(({ path }) => path))
	const cache = new Map()
	return (fromPath, specifier) => {
		if (!specifier.startsWith('.')) return null
		const key = `${fromPath}\0${specifier}`
		if (cache.has(key)) return cache.get(key)
		const base = resolve(cwd, dirname(fromPath), specifier.replace(/\.(?:m?js|jsx)$/, ''))
		let found = null
		for (const extension of RESOLVED_EXTENSIONS) {
			const candidate = relative(cwd, base + extension)
			if (known.has(candidate)) {
				found = candidate
				break
			}
		}
		cache.set(key, found)
		return found
	}
}

/** What the first pass learned about every file, as the questions `transformSource` asks. */
function runKnowledge(files, outcomes, cwd) {
	const resolve = resolver(files, cwd)
	const kExports = new Map()
	const imported = new Set()
	const parsed = new Set()
	files.forEach(({ path }, index) => {
		const facts = outcomes[index].facts
		if (!facts) return
		kExports.set(path, new Set(facts.kExports))
		for (const binding of facts.imports) {
			const target = resolve(path, binding.source)
			if (target) imported.add(`${target}#${binding.imported}`)
		}
		for (const binding of facts.parsedImports) {
			const target = resolve(path, binding.source)
			if (target) parsed.add(`${target}#${binding.imported}`)
		}
	})
	return {
		isK(fromPath, specifier, name) {
			const target = resolve(fromPath, specifier)
			return target !== null && kExports.get(target)?.has(name) === true
		},
		isImported: (path, name) => imported.has(`${path}#${name}`),
		isParsed: (path, name) => parsed.has(`${path}#${name}`),
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	try {
		console.log(run(process.argv.slice(2)).summary)
	} catch (error) {
		console.error(error.message)
		process.exit(1)
	}
}
