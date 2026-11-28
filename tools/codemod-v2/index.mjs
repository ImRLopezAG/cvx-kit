#!/usr/bin/env node
// cvx-kit v2 codemod: rewrites the mechanical majority of Zod schema and kit
// table call sites to `k` and reports every site it left for manual work.
// --no-getters keeps function args / returns as data properties.
// --native-number-bounds omits .finite() on k.number(); integers stay safe.
// Without --write this is a dry run, apart from an optional report.
// Repeated knowledge passes resolve imported schemas and their held components across the run.
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
import { REPORT_FIXES } from './report-codes.mjs'
import { buildReport, formatSummary } from './report.mjs'
import { createSourceResolver, KIT_OR_ZOD_MODULE } from './resolve.mjs'
import { formatRestoreSummary, gitReader, restoreStrictSource } from './restore-strict.mjs'
import { transformSource } from './transform.mjs'
import { parentMap, parseSource, unwrap, walk } from './transforms/ast.mjs'
import {
	consumerOrigin as expressionConsumerOrigin,
	registrationImportKind,
} from './transforms/consumer.mjs'
import { constantMaskKeys, stringEnumArgument, tupleSlot } from './transforms/schema.mjs'

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
failed to parse, a held Zod pipe targets a rewritten k schema, or the arguments are invalid.
The report is still written for parse errors and held pipes.

Number bounds: k.int() and .int() reject integers outside the safe range by default.
The codemod emits integers without redundant .safe() calls. Zod's z.number() refuses NaN and
infinities, so by default it becomes k.number().finite() (number-finite-preserved).
--native-number-bounds emits k.number() instead (number-now-accepts-nan); it only affects
finite-number checks, never integer safety.

--restore-strict <ref> is for apps migrated with the 2.0.0-beta.0 to beta.2 codemod, which wrote
z.strictObject(...) and .strict() as a plain k.object(...). Since beta.3 that strips unknown keys
under parse. This mode rewrites nothing else: it reads each file as it was at <ref> (the commit
before the migration), pairs its Zod objects with the file's current ones by their bindings and field names and
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
	const packageFor = packageLookup()
	const clientOnly = new Set()
	const packages = new Set(
		files.map(({ file }) => packageFor(dirname(file))?.directory).filter(Boolean),
	)
	for (const directory of packages) {
		// Only a package that lists the kit can be client-only, and the override skips the boundary.
		if (options.includePackagesWithoutKit || !packageFor(directory)?.hasKit) continue
		const imports = []
		const sources = collectFiles(
			{ paths: [directory], extensions: options.extensions, ignore: [] },
			cwd,
		)
		for (const file of sources) {
			if (packageFor(dirname(file))?.directory !== directory) continue
			const text = readFileSync(file, 'utf8')
			if (!text.includes('cvx-kit')) continue
			const parsed = parseSource(file, text)
			for (const statement of parsed.program.body) {
				const module = statement.source?.value
				if (module === 'cvx-kit' || module?.startsWith('cvx-kit/')) imports.push(module)
			}
		}
		if (
			imports.length > 0 &&
			imports.every((entry) => /^cvx-kit\/(?:react|client)(?:\/|$)/.test(entry))
		)
			clientOnly.add(directory)
	}
	const packagesWithoutKit = new Set()
	const excluded = new Map()
	for (const { file, path, source } of files) {
		const pkg = packageFor(dirname(file))
		if (!pkg || (pkg.hasKit && !clientOnly.has(pkg.directory)) || options.includePackagesWithoutKit)
			continue
		packagesWithoutKit.add(relative(cwd, pkg.directory) || '.')
		excluded.set(path, {
			path,
			output: source,
			status: 'untouched',
			rewritten: 0,
			skipped: [],
			info: [
				{
					line: 1,
					column: 1,
					code: 'package-without-cvx-kit',
					text: relative(cwd, pkg.directory) || '.',
				},
			],
			declarations: { rewritten: 0, left: 0 },
			facts: null,
		})
	}
	const transformOptions = {
		getters: options.getters,
		nativeNumberBounds: options.nativeNumberBounds,
	}
	let first = files.map(
		({ path, source }) =>
			excluded.get(path) ??
			transformSource(path, source, { ...transformOptions, deferForeign: true }),
	)
	const lookup = { resolve: createSourceResolver(cwd), programs: new Map() }
	let knowledge = runKnowledge(files, first, cwd, lookup)
	for (let pass = 0; pass <= files.length; pass++) {
		const next = files.map(
			({ path, source }) =>
				excluded.get(path) ??
				transformSource(path, source, { ...transformOptions, run: knowledge }),
		)
		const stable = next.every(
			(outcome, index) => JSON.stringify(outcome.facts) === JSON.stringify(first[index].facts),
		)
		first = next
		knowledge = runKnowledge(files, first, cwd, lookup)
		if (stable) break
	}
	const results = []
	for (const { file, path, source } of files) {
		const outcome =
			excluded.get(path) ?? transformSource(path, source, { ...transformOptions, run: knowledge })
		if (options.write && outcome.output !== source) writeFileSync(file, outcome.output)
		results.push(outcome)
	}
	const projectRoot = realpathSync(reportRoot(cwd))
	const report = {
		...buildReport(
			results.map((outcome) => ({
				...outcome,
				path: relative(projectRoot, realpathSync(resolve(cwd, outcome.path))),
			})),
		),
		outsideRoots: outside,
		packagesWithoutKit: [...packagesWithoutKit].sort(),
	}
	if (options.report)
		writeFileSync(resolve(cwd, options.report), `${JSON.stringify(report, null, '\t')}\n`)
	let summary = formatSummary(report, options.write)
	if (outside.length > 0)
		summary += `\nskipped symlinks outside the given paths: ${outside.length}\n${outside.map((path) => `  ${path}`).join('\n')}`
	// A file that failed to parse fails the run, after the report is written.
	return {
		report,
		summary,
		exitCode: report.summary.error > 0 || report.totals['held-pipe-to-k'] > 0 ? 1 : 0,
	}
}

/** Cache the nearest package result for every visited directory, including manifest-free parents. */
function packageLookup() {
	const cache = new Map()
	const lookup = (directory) => {
		if (cache.has(directory)) return cache.get(directory)
		const manifest = join(directory, 'package.json')
		let pkg
		if (existsSync(manifest)) {
			const json = JSON.parse(readFileSync(manifest, 'utf8'))
			pkg = {
				directory,
				hasKit:
					json.name === 'cvx-kit' ||
					['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some(
						(key) => Object.hasOwn(json[key] ?? {}, 'cvx-kit'),
					),
			}
		} else pkg = dirname(directory) === directory ? null : lookup(dirname(directory))
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
	const report = {
		restoreStrict: options.restoreStrict,
		codes: Object.fromEntries(
			[...new Set(results.flatMap((result) => result.manual.map((site) => site.code)))].map(
				(code) => [code, REPORT_FIXES[code]],
			),
		),
		files: results,
	}
	if (options.report)
		writeFileSync(resolve(cwd, options.report), `${JSON.stringify(report, null, '\t')}\n`)
	return {
		report,
		summary: formatRestoreSummary(results, options.restoreStrict, options.write),
		exitCode: results.some((result) => result.error) ? 1 : 0,
	}
}

/** What the first pass learned about every file, as the questions `transformSource` asks. */
function runKnowledge(files, outcomes, cwd, { resolve, programs }) {
	// Every pass asks about the same files, so each is read and parsed once per run.
	const programOf = (target) => {
		let program = programs.get(target)
		if (!program) {
			program = parseSource(target, readFileSync(join(cwd, target), 'utf8')).program
			programs.set(target, program)
		}
		return program
	}
	const kExports = new Map()
	const tableExports = new Map()
	files.forEach(({ path }, index) => {
		const facts = outcomes[index].facts
		if (!facts) return
		kExports.set(path, new Set(facts.kExports))
		tableExports.set(path, new Set(facts.tableExports))
	})
	return {
		resolveSource: resolve,
		tupleSlot(from, specifier, name, seen = new Set()) {
			const target = resolve(from, specifier)
			if (!target || !this.isK(from, specifier, name) || seen.has(`${target}:${name}`))
				return 'unknown'
			seen = new Set(seen).add(`${target}:${name}`)
			const program = programOf(target)
			const parents = parentMap(program)
			const zodNamespaces = new Set()
			let hasK = false
			for (const statement of program.body) {
				if (statement.type !== 'ImportDeclaration') continue
				for (const spec of statement.specifiers) {
					if (
						/^zod(?:\/|$)/.test(statement.source.value) &&
						(spec.type !== 'ImportSpecifier' || spec.imported.name === 'z')
					)
						zodNamespaces.add(spec.local.name)
					if (spec.local.name === 'k' && /^cvx-kit(?:\/k)?$/.test(statement.source.value))
						hasK = true
				}
			}
			for (const statement of program.body) {
				if (statement.type === 'ExportNamedDeclaration') {
					for (const spec of statement.specifiers) {
						if ((spec.exported.name ?? spec.exported.value) !== name) continue
						if (statement.source)
							return this.tupleSlot(
								target,
								statement.source.value,
								spec.local.name ?? spec.local.value,
								seen,
							)
						name = spec.local.name
					}
				}
			}
			for (const statement of program.body) {
				const declaration = statement.declaration ?? statement
				if (declaration.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue
				const item = declaration.declarations.find((item) => item.id.name === name)
				if (item?.init)
					return tupleSlot(
						{
							parents,
							zodNamespaces,
							hasK,
							path: target,
							options: {
								run: {
									tupleSlot: (path, source, exported) =>
										this.tupleSlot(path, source, exported, seen),
								},
							},
						},
						item.init,
					)
			}
			return 'unknown'
		},
		schemaPaths(from, specifier, name, seen = new Set()) {
			const target = resolve(from, specifier)
			if (!target || !kExports.has(target) || seen.has(`${target}:${name}`)) return []
			seen = new Set(seen).add(`${target}:${name}`)
			const paths = [...kExports.get(target)]
				.filter((path) => path === name || path.startsWith(`${name}.`))
				.map((path) => path.slice(name.length))
			const [head, ...members] = name.split('.')
			for (const statement of programOf(target).body) {
				if (statement.type !== 'ExportNamedDeclaration' || !statement.source) continue
				for (const spec of statement.specifiers) {
					if ((spec.exported.name ?? spec.exported.value) === head)
						paths.push(
							...this.schemaPaths(
								target,
								statement.source.value,
								[spec.local.name ?? spec.local.value, ...members].join('.'),
								seen,
							),
						)
				}
			}
			return paths
		},
		maskKeys(from, specifier, name, seen = new Set()) {
			const target = resolve(from, specifier)
			if (!target || seen.has(`${target}:${name}`)) return null
			seen = new Set(seen).add(`${target}:${name}`)
			const program = programOf(target)
			for (const statement of program.body) {
				if (statement.type !== 'ExportNamedDeclaration') continue
				for (const spec of statement.specifiers) {
					if ((spec.exported.name ?? spec.exported.value) !== name) continue
					if (statement.source)
						return this.maskKeys(
							target,
							statement.source.value,
							spec.local.name ?? spec.local.value,
							seen,
						)
					name = spec.local.name ?? spec.local.value
				}
			}
			for (const statement of program.body) {
				const declaration = statement.declaration ?? statement
				if (declaration.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue
				const item = declaration.declarations.find((item) => item.id.name === name)
				if (item) {
					const init = unwrap(item.init)
					return init?.type === 'ObjectExpression'
						? constantMaskKeys({ parents: parentMap(program) }, init)
						: null
				}
			}
			return null
		},

		isStringEnum(from, specifier, name, arrayOnly = false, seen = new Set()) {
			const target = resolve(from, specifier)
			if (!target || seen.has(`${target}:${name}`)) return false
			seen = new Set(seen).add(`${target}:${name}`)
			const program = programOf(target)
			const explicit = program.body.some(
				(statement) =>
					statement.type === 'ExportNamedDeclaration' &&
					(statement.declaration?.id?.name === name ||
						statement.declaration?.declarations?.some((item) => item.id.name === name) ||
						statement.specifiers.some(
							(spec) => (spec.exported.name ?? spec.exported.value) === name,
						)),
			)
			for (const statement of program.body) {
				if (statement.type !== 'ExportNamedDeclaration') continue
				for (const spec of statement.specifiers) {
					if ((spec.exported.name ?? spec.exported.value) !== name) continue
					const local = spec.local.name ?? spec.local.value
					if (statement.source)
						return this.isStringEnum(target, statement.source.value, local, arrayOnly, seen)
					name = local
				}
			}
			if (!explicit)
				for (const statement of program.body) {
					if (
						statement.type === 'ExportAllDeclaration' &&
						!statement.exported &&
						this.isStringEnum(target, statement.source.value, name, arrayOnly, new Set(seen))
					)
						return true
				}
			const imported = new Map()
			for (const statement of program.body) {
				if (statement.type !== 'ImportDeclaration') continue
				for (const spec of statement.specifiers) {
					if (spec.type === 'ImportSpecifier')
						imported.set(spec.local.name, {
							source: statement.source.value,
							imported: spec.imported.name,
						})
				}
			}
			return stringEnumArgument(
				{
					program,
					parents: parentMap(program),
					imported,
					path: target,
					options: {
						run: {
							isStringEnum: (from, source, name, arrays) =>
								this.isStringEnum(from, source, name, arrays, seen),
						},
					},
				},
				{ type: 'Identifier', name },
				new Set(),
				arrayOnly,
			)
		},
		registrationKind(from, specifier, name, path = []) {
			return this.consumerOrigin(from, specifier, name, path, new Set(), true)
		},
		consumerOrigin(from, specifier, name, path = [], seen = new Set(), builder = false) {
			if (builder) {
				const kind = registrationImportKind(specifier, name)
				if (kind) return kind
			}
			const target = resolve(from, specifier)
			if (builder && !kExports.has(target)) return 'unproven'
			if (!target && (specifier.startsWith('.') || specifier.startsWith('/'))) return 'unproven'
			if (!target) return !KIT_OR_ZOD_MODULE.test(specifier)
			const key = `${target}:${name}:${path.join('.')}`
			if (seen.has(key)) return 'unproven'
			seen.add(key)
			const program = programOf(target)
			const context = {
				path: target,
				parents: parentMap(program),
				options: {
					run: {
						consumerOrigin: (from, source, name, members) =>
							this.consumerOrigin(from, source, name, members, seen),
					},
				},
			}
			if (builder)
				context.importOrigin = (source, imported, members) =>
					this.consumerOrigin(target, source, imported, members, seen, true)
			for (const statement of program.body) {
				if (statement.type === 'ExportDefaultDeclaration' && name === 'default')
					return expressionConsumerOrigin(context, statement.declaration, path)
				if (statement.type !== 'ExportNamedDeclaration') continue
				for (const spec of statement.specifiers) {
					if ((spec.exported.name ?? spec.exported.value) !== name) continue
					if (statement.source)
						return this.consumerOrigin(
							target,
							statement.source.value,
							spec.local.name ?? spec.local.value,
							path,
							seen,
							builder,
						)
					return expressionConsumerOrigin(context, spec.local, path)
				}
				const declaration = statement.declaration
				if (declaration?.type === 'FunctionDeclaration' && declaration.id?.name === name)
					return false
				if (declaration?.type !== 'VariableDeclaration') continue
				for (const item of declaration.declarations) {
					if (item.id.type === 'Identifier' && item.id.name === name && item.init)
						return expressionConsumerOrigin(context, item.init, path)
					if (builder && item.id.type === 'ObjectPattern') {
						let identifier
						walk(item.id, (node) => {
							if (node.type === 'Identifier' && node.name === name) identifier = node
						})
						if (identifier) return expressionConsumerOrigin(context, identifier, path)
					}
				}
			}
			return 'unproven'
		},
		isTable(fromPath, specifier, name, seen = new Set()) {
			const target = resolve(fromPath, specifier)
			if (!target || !tableExports.has(target) || seen.has(`${target}:${name}`)) return false
			if (tableExports.get(target).has(name)) return true
			seen = new Set(seen).add(`${target}:${name}`)
			const [head, ...members] = name.split('.')
			for (const statement of programOf(target).body) {
				if (statement.type !== 'ExportNamedDeclaration' || !statement.source) continue
				for (const spec of statement.specifiers) {
					if (
						(spec.exported.name ?? spec.exported.value) === head &&
						this.isTable(
							target,
							statement.source.value,
							[spec.local.name ?? spec.local.value, ...members].join('.'),
							seen,
						)
					)
						return true
				}
			}
			return false
		},
		isK(fromPath, specifier, name) {
			return this.schemaPaths(fromPath, specifier, name).includes('')
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

/** Stable report paths use the nearest project manifest, or its workspace/repository root. */
function reportRoot(cwd) {
	let current = resolve(cwd)
	let nearest = null
	for (;;) {
		const manifest = join(current, 'package.json')
		if (existsSync(join(current, '.git'))) return current
		if (existsSync(manifest)) {
			nearest ??= current
			if (JSON.parse(readFileSync(manifest, 'utf8')).workspaces) return current
		}
		if (dirname(current) === current) return nearest ?? resolve(cwd)
		current = dirname(current)
	}
}
