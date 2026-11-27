#!/usr/bin/env node
// cvx-kit v2 codemod: rewrites the mechanical majority of Zod schema and kit
// table call sites to `k` and reports every site it left for manual work.
// --no-getters keeps function args / returns as data properties.
// --native-number-bounds omits .finite() on k.number(); integers stay safe.
// Without --write this is a dry run, apart from an optional report.
// Two passes resolve imported schema type helpers across the run.
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join, matchesGlob, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildReport, formatSummary } from './report.mjs'
import { formatRestoreSummary, gitReader, restoreStrictSource } from './restore-strict.mjs'
import { transformSource } from './transform.mjs'

export const HELP = `Usage: cvx-kit-codemod-v2 <path…> [options]

Rewrites Zod schema and kit table call sites to k and reports the sites left for manual work.
Without --write it is a dry run and writes nothing but the optional report.

  --write                 write the rewritten files
  --report <file>         write the JSON report
  --ext ts,tsx,mts        file extensions to scan
  --no-getters            keep function args / returns as data properties
  --native-number-bounds  omit .finite() on k.number() (see below)
  --include-packages-without-kit  rewrite packages that do not depend on cvx-kit
  --ignore <glob…>        skip matching paths
  --restore-strict <ref>  only restore k.strictObject from the pre-migration git ref (see below)
  --help                  print this help

Paths must be files or directories; the codemod does not expand globs (let the shell expand an
unquoted one, or pass the directory and --ignore what to skip). A symlink whose real path is
outside the given paths is skipped and listed in the report (outsideRoots), so --write never
edits a file outside them.

Exit codes: 0 when every file parsed (skipped sites are listed, not failures); 1 when a file
failed to parse (the report is still written; see its "error" files) or the arguments are invalid.

Number bounds: k.int() and .int() reject integers outside the safe range by default.
The codemod emits integers without redundant .safe() calls. Zod's z.number() refuses NaN and
infinities, so by default it becomes k.number().finite() (number-finite-preserved).
--native-number-bounds emits k.number() instead (number-now-accepts-nan); it only affects
finite-number checks, never integer safety.

--restore-strict <ref> is for apps migrated with the 2.0.0-beta.0 to beta.2 codemod, which wrote
z.strictObject(...) and .strict() as a plain k.object(...). Since beta.3 that strips unknown keys
under parse. This mode rewrites nothing else: it reads each file as it was at <ref> (the commit
before the migration), pairs its Zod objects with the file's current ones by their field names and
turns each k.object that was strict into k.strictObject. Sites it cannot pair are listed.
`

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
		nativeNumberBounds: false,
		includePackagesWithoutKit: false,
	}
	let list = options.paths
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]
		if (arg === '--help' || arg === '-h') {
			options.help = true
		} else if (arg === '--write') {
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
			options.deprecatedNoStripParsed = true
			list = options.paths
		} else if (arg === '--native-number-bounds') {
			options.nativeNumberBounds = true
			list = options.paths
		} else if (arg === '--include-packages-without-kit') {
			options.includePackagesWithoutKit = true
			list = options.paths
		} else if (arg === '--restore-strict') {
			options.restoreStrict = argv[++index]
			if (!options.restoreStrict || options.restoreStrict.startsWith('--'))
				throw new Error('--restore-strict needs a git ref')
			list = options.paths
		} else if (arg === '--ignore') {
			list = options.ignore
		} else if (arg.startsWith('--')) {
			throw new Error(`Unknown option ${arg}`)
		} else list.push(arg)
	}
	if (options.help) return options
	if (options.paths.length === 0) throw new Error('Pass at least one path')
	return options
}

/**
 * The files to scan. A symlinked file or directory is followed only when its real path is inside one
 * of the given paths; others are skipped and pushed to `outside` (run-relative), so `--write` never
 * reaches a file outside them. Each real directory is visited once, so a link cycle cannot loop.
 */
export function collectFiles(options, cwd = process.cwd(), outside = []) {
	const files = []
	const roots = options.paths.map((path) => {
		const absolute = resolve(cwd, path)
		if (!existsSync(absolute))
			throw new Error(
				`Path not found: ${path}. Paths must be files or directories${/[*?[\]{}]/.test(path) ? '; the codemod does not expand globs (pass the directory, or leave the glob unquoted for the shell to expand)' : ''}`,
			)
		return realpathSync(absolute)
	})
	const inside = (real) => roots.some((root) => real === root || real.startsWith(root + sep))
	const seen = new Set()
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
		const real = realpathSync(path)
		if (lstatSync(path).isSymbolicLink() && !inside(real)) {
			outside.push(relative(cwd, path))
			return
		}
		if (statSync(path).isDirectory()) {
			if (seen.has(real)) return
			seen.add(real)
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
	if (options.deprecatedNoStripParsed)
		console.error('--no-strip-parsed is deprecated and no longer does anything.')
	const outside = []
	const files = collectFiles(options, cwd, outside).map((file) => ({
		file,
		path: relative(cwd, file),
		source: readFileSync(file, 'utf8'),
	}))
	if (options.restoreStrict !== undefined) return restoreStrict(options, files, cwd)
	const packageFor = packageLookup(cwd)
	const packagesWithoutKit = new Set()
	const excluded = new Map()
	for (const { file, path, source } of files) {
		const pkg = packageFor(dirname(file))
		if (!pkg || pkg.hasKit || options.includePackagesWithoutKit) continue
		packagesWithoutKit.add(relative(cwd, pkg.directory) || '.')
		excluded.set(path, {
			path, output: source, status: 'untouched', rewritten: 0, skipped: [],
			info: [{ line: 1, column: 1, code: 'package-without-cvx-kit', text: relative(cwd, pkg.directory) || '.' }],
			declarations: { rewritten: 0, left: 0 }, facts: null,
		})
	}
	const transformOptions = {
		getters: options.getters,
		nativeNumberBounds: options.nativeNumberBounds,
	}
	const first = files.map(({ path, source }) => excluded.get(path) ?? transformSource(path, source, transformOptions))
	const knowledge = runKnowledge(files, first, cwd)
	const results = []
	for (const { file, path, source } of files) {
		const outcome = excluded.get(path) ?? transformSource(path, source, { ...transformOptions, run: knowledge })
		if (options.write && outcome.output !== source) writeFileSync(file, outcome.output)
		results.push(outcome)
	}
	const report = { ...buildReport(results), outsideRoots: outside, packagesWithoutKit: [...packagesWithoutKit].sort() }
	if (options.report)
		writeFileSync(resolve(cwd, options.report), `${JSON.stringify(report, null, '\t')}\n`)
	let summary = formatSummary(report, options.write)
	if (outside.length > 0)
		summary += `\nskipped symlinks outside the given paths: ${outside.length}\n${outside.map((path) => `  ${path}`).join('\n')}`
	// A file that failed to parse fails the run, after the report is written.
	return { report, summary, exitCode: report.summary.error > 0 ? 1 : 0 }
}

/** Cache the nearest package result for every visited directory, including manifest-free parents. */
function packageLookup(cwd) {
	const root = resolve(cwd)
	const cache = new Map()
	const lookup = (directory) => {
		if (cache.has(directory)) return cache.get(directory)
		if (directory !== root && !directory.startsWith(root + sep)) return null
		const manifest = join(directory, 'package.json')
		let pkg
		if (existsSync(manifest)) {
			const json = JSON.parse(readFileSync(manifest, 'utf8'))
			pkg = { directory, hasKit: json.name === 'cvx-kit' ||
				['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some((key) => Object.hasOwn(json[key] ?? {}, 'cvx-kit')) }
		} else pkg = directory === root ? null : lookup(dirname(directory))
		cache.set(directory, pkg)
		return pkg
	}
	return lookup
}

/** The `--restore-strict` run: no other rewrite happens in it. */
function restoreStrict(options, files, cwd) {
	const read = gitReader(options.restoreStrict, cwd)
	const results = files.map(({ file, path, source }) => {
		const base = read(file)
		try {
			const outcome = restoreStrictSource(path, source, base)
			if (options.write && outcome.output !== source) writeFileSync(file, outcome.output)
			const { output: _output, ...rest } = outcome
			return { ...rest, noBase: base === null }
		} catch (error) {
			return { path, restored: 0, already: 0, manual: [], noBase: false, error: error.message }
		}
	})
	const report = { restoreStrict: options.restoreStrict, files: results }
	if (options.report)
		writeFileSync(resolve(cwd, options.report), `${JSON.stringify(report, null, '\t')}\n`)
	return {
		report,
		summary: formatRestoreSummary(results, options.restoreStrict, options.write),
		exitCode: results.some((result) => result.error) ? 1 : 0,
	}
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
	const tableExports = new Map()
	files.forEach(({ path }, index) => {
		const facts = outcomes[index].facts
		if (!facts) return
		kExports.set(path, new Set(facts.kExports))
		tableExports.set(path, new Set(facts.tableExports))
	})
	return {
		isTable(fromPath, specifier, name) {
			const target = resolve(fromPath, specifier)
			return target !== null && tableExports.get(target)?.has(name) === true
		},
		isK(fromPath, specifier, name) {
			const target = resolve(fromPath, specifier)
			return target !== null && kExports.get(target)?.has(name) === true
		},
	}
}

// A package bin is a symlink: compare against the resolved script path, or the CLI silently does nothing.
if (isMain()) {
	try {
		const argv = process.argv.slice(2)
		if (argv.includes('--help') || argv.includes('-h')) {
			if (argv.includes('--no-strip-parsed'))
				console.error('--no-strip-parsed is deprecated and no longer does anything.')
			console.log(HELP)
		} else {
			const outcome = run(argv)
			console.log(outcome.summary)
			process.exitCode = outcome.exitCode
		}
	} catch (error) {
		console.error(error.message)
		process.exit(1)
	}
}

function isMain() {
	const script = process.argv[1]
	if (!script) return false
	try {
		return import.meta.url === pathToFileURL(realpathSync(script)).href
	} catch {
		return false
	}
}
