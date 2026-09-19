import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { parseSync, Visitor, type Program, type Node, type CallExpression } from 'oxc-parser'
import { ResolverFactory } from 'oxc-resolver'

export interface ArchitectureOptions {
	cwd?: string
	convexDir?: string
}
export interface ArchitectureDiagnostic {
	code:
		| 'missing-root'
		| 'root-directory'
		| 'tests'
		| 'test-location'
		| 'parse'
		| 'cycle'
		| 'symlink'
		| 'domain-entry'
		| 'shared-owner'
	file: string
	message: string
}

/** Full-project checks, independent of the consumer's test runner. No persistent cache. */
export function inspectArchitecture(options: ArchitectureOptions = {}): ArchitectureDiagnostic[] {
	const requestedRoot = resolve(options.cwd ?? process.cwd(), options.convexDir ?? 'convex')
	const root = existsSync(requestedRoot) ? realpathSync(requestedRoot) : requestedRoot
	const diagnostics: ArchitectureDiagnostic[] = []
	if (!existsSync(root))
		return [
			{ code: 'missing-root', file: '.', message: `Convex directory does not exist: ${root}` },
		]
	const files = sourceFiles(root, diagnostics)
	const required = new Set<string>()
	const tested = new Set<string>()
	const graph = new Map<string, Set<string>>()
	const dependencies = new Map<string, Set<string>>()
	const resolver = createResolver()
	for (const file of files) {
		const filename = resolve(root, file)
		const parsed = parseSync(filename, readFileSync(filename, 'utf8'))
		if (parsed.errors.length) {
			diagnostics.push({
				code: 'parse',
				file,
				message: `Cannot validate ${file}: ${parsed.errors[0].message}`,
			})
			continue
		}
		if (testFile(file)) {
			if (!file.includes('__tests__/'))
				diagnostics.push({
					code: 'test-location',
					file,
					message: 'Place tests in a sibling __tests__/ directory.',
				})
			else if (dirname(file).endsWith('__tests__') && hasRunnableTest(parsed.program))
				tested.add(dirname(dirname(file)))
			continue
		}
		if (file.split('/').includes('__tests__')) continue
		if (/^domain\/[^/]+$/.test(file) && file !== 'domain/table.ts')
			diagnostics.push({
				code: 'domain-entry',
				file,
				message:
					'Domain source belongs in domain/<module>/ or domain/shared/. Only domain/table.ts assembles module tables.',
			})
		if (executable(parsed.program) && file !== 'domain/table.ts') required.add(dirname(file))
		const owner = moduleOwner(file) ?? ''
		const targets = new Set<string>()
		dependencies.set(file, targets)
		for (const source of runtimeImports(parsed.program)) {
			const target = resolveImport(resolver, filename, source)
			if (!target) continue
			const targetFile = relative(root, target).split(sep).join('/')
			targets.add(targetFile)
			const targetOwner = moduleOwner(targetFile)
			if (owner && targetOwner && owner !== targetOwner) {
				const edges = graph.get(owner) ?? new Set<string>()
				graph.set(owner, edges)
				edges.add(targetOwner)
			}
		}
	}
	for (const directory of required) {
		if (!tested.has(directory))
			diagnostics.push({
				code: 'tests',
				file: directory,
				message: `${directory}/__tests__/ must contain a .test or .spec file with a nonempty, non-skipped test. Parent or child suites do not count.`,
			})
	}
	diagnostics.push(...sharedOwnership(dependencies))
	for (const cycle of cycles(graph))
		diagnostics.push({
			code: 'cycle',
			file: cycle[0],
			message: `Module dependency cycle: ${cycle.join(' → ')}.`,
		})
	return diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.code.localeCompare(b.code))
}

export function createResolver() {
	return new ResolverFactory({
		tsconfig: 'auto',
		extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
		extensionAlias: {
			'.js': ['.ts', '.tsx', '.js'],
			'.mjs': ['.mts', '.mjs'],
			'.cjs': ['.cts', '.cjs'],
		},
		conditionNames: ['types', 'import', 'node', 'default'],
		symlinks: true,
	})
}

export function resolveImport(resolver: ResolverFactory, filename: string, source: string) {
	const found = resolver.resolveFileSync(filename, source).path
	if (found) return found
	// Keep path checks useful in unsaved/editor fixtures and before Convex codegen.
	return source.startsWith('.') ? resolve(dirname(filename), source) : null
}

/** The lint rule runs the project scan on one deterministic source file. */
export function architectureAnchor(root: string) {
	if (!existsSync(root)) return null
	if (existsSync(resolve(root, 'convex.config.ts')))
		return realpathSync(resolve(root, 'convex.config.ts'))
	root = realpathSync(root)
	for (const file of sourceFiles(root, []))
		if (!file.includes('__tests__/') && !testFile(file)) return resolve(root, file)
	return null
}

function* sourceFiles(root: string, diagnostics: ArchitectureDiagnostic[]): Generator<string> {
	const allowed = new Set([
		'_generated',
		'__tests__',
		'api',
		'domain',
		'application',
		'migrations',
		'components',
	])
	function* scan(directory: string): Generator<string> {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const path = resolve(directory, entry.name)
			const file = relative(root, path).split(sep).join('/')
			if (entry.isSymbolicLink()) {
				diagnostics.push({
					code: 'symlink',
					file,
					message:
						'Keep application source inside its owning directory; symlinked files and folders are not allowed.',
				})
				continue
			}
			if (entry.isDirectory()) {
				if (directory === root && !allowed.has(entry.name))
					diagnostics.push({
						code: 'root-directory',
						file,
						message: `Root folder ${entry.name}/ is not allowed. Use api/, domain/, application/, migrations/, components/, __tests__/, or _generated/.`,
					})
				if (
					entry.name !== '_generated' &&
					entry.name !== 'node_modules' &&
					!entry.name.startsWith('.')
				)
					yield* scan(path)
			} else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) yield file
		}
	}
	yield* scan(root)
}

function testFile(file: string) {
	return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
}

function executable(program: Program) {
	return program.body.some((statement) => {
		const declaration =
			statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
		if (declaration && 'declare' in declaration && declaration.declare) return false
		if (statement.type === 'ImportDeclaration' || statement.type === 'EmptyStatement') return false
		if (statement.type === 'ExportNamedDeclaration') {
			if (statement.exportKind === 'type' || !statement.declaration) return false
			return !['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction'].includes(
				statement.declaration.type,
			)
		}
		return ![
			'TSInterfaceDeclaration',
			'TSTypeAliasDeclaration',
			'TSDeclareFunction',
			'ExportAllDeclaration',
		].includes(statement.type)
	})
}

function hasRunnableTest(program: Program) {
	const names = new Map([
		['test', 'test'],
		['it', 'it'],
		['describe', 'describe'],
		['suite', 'suite'],
	])
	for (const statement of program.body) {
		const declaration =
			statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
		if (declaration?.type === 'FunctionDeclaration' && declaration.id)
			names.delete(declaration.id.name)
		if (declaration?.type === 'VariableDeclaration')
			for (const item of declaration.declarations) {
				if (item.id.type === 'Identifier') names.delete(item.id.name)
			}
		if (statement.type !== 'ImportDeclaration') continue
		for (const specifier of statement.specifiers) {
			names.delete(specifier.local.name)
			if (
				!['vitest', 'vite-plus/test', 'bun:test', 'node:test', '@jest/globals'].includes(
					statement.source.value,
				)
			)
				continue
			if (specifier.type === 'ImportNamespaceSpecifier') names.set(specifier.local.name, '*')
			else if (specifier.type === 'ImportDefaultSpecifier') names.set(specifier.local.name, 'test')
			else if (specifier.imported.type === 'Identifier')
				names.set(specifier.local.name, specifier.imported.name)
		}
	}
	const calls: CallExpression[] = []
	new Visitor({
		CallExpression(node) {
			calls.push(node)
		},
	}).visit(program)
	const skipped = calls.filter((node) => {
		const parts = testCallee(node.callee, names)
		return (
			['test', 'it', 'describe', 'suite'].includes(parts[0]) &&
			(parts.some((part) => ['skip', 'todo', 'skipIf', 'runIf'].includes(part)) ||
				node.arguments.some(
					(argument) =>
						argument.type === 'ObjectExpression' &&
						argument.properties.some(
							(property) =>
								property.type === 'Property' &&
								['skip', 'todo'].includes(
									property.key.type === 'Identifier'
										? property.key.name
										: property.key.type === 'Literal'
											? String(property.key.value)
											: '',
								) &&
								!(property.value.type === 'Literal' && property.value.value === false),
						),
				))
		)
	})
	return calls.some((node) => {
		const parts = testCallee(node.callee, names)
		if (
			!['test', 'it'].includes(parts[0]) ||
			skipped.some((skip) => node.start >= skip.start && node.end <= skip.end)
		)
			return false
		// each(...) is a factory; only the outer call has the test callback.
		return node.arguments.some(
			(argument) =>
				(argument.type === 'ArrowFunctionExpression' || argument.type === 'FunctionExpression') &&
				argument.body &&
				(argument.body.type !== 'BlockStatement' ||
					argument.body.body.some((statement) => statement.type !== 'EmptyStatement')),
		)
	})
}

function testCallee(node: Node, names: Map<string, string>): string[] {
	if (node.type === 'Identifier') {
		const name = names.get(node.name)
		return name ? [name] : []
	}
	if (node.type === 'CallExpression') return testCallee(node.callee, names)
	if (node.type === 'MemberExpression') {
		const base = testCallee(node.object, names)
		const property =
			!node.computed && node.property.type === 'Identifier'
				? node.property.name
				: node.property.type === 'Literal'
					? String(node.property.value)
					: ''
		if (!base.length || !property) return []
		return base[0] === '*' ? [property] : [...base, property]
	}
	return []
}

function runtimeImports(program: Program) {
	const imports: string[] = []
	new Visitor({
		ImportDeclaration(node) {
			if (
				node.importKind !== 'type' &&
				(node.specifiers.length === 0 ||
					node.specifiers.some((s) => s.type !== 'ImportSpecifier' || s.importKind !== 'type'))
			)
				imports.push(node.source.value)
		},
		ExportNamedDeclaration(node) {
			if (
				node.source &&
				node.exportKind !== 'type' &&
				node.specifiers.some((specifier) => specifier.exportKind !== 'type')
			)
				imports.push(node.source.value)
		},
		ExportAllDeclaration(node) {
			if (node.exportKind !== 'type') imports.push(node.source.value)
		},
		ImportExpression(node) {
			if (node.source.type === 'Literal' && String(node.source.value) === node.source.value)
				imports.push(String(node.source.value))
		},
	}).visit(program)
	return imports
}

function moduleOwner(file: string) {
	const parts = file.split('/')
	return parts[0] === 'domain' && parts.length >= 3 && parts[1] !== '__tests__'
		? `domain/${parts[1]}`
		: null
}

function cycles(graph: Map<string, Set<string>>) {
	const completed = new Set<string>()
	const stack: string[] = []
	const found: string[][] = []
	function visit(owner: string) {
		const index = stack.indexOf(owner)
		if (index >= 0) {
			found.push([...stack.slice(index), owner])
			return
		}
		if (completed.has(owner)) return
		stack.push(owner)
		for (const dependency of graph.get(owner) ?? []) visit(dependency)
		stack.pop()
		completed.add(owner)
	}
	for (const owner of graph.keys()) visit(owner)
	return found
}

function sharedOwnership(dependencies: Map<string, Set<string>>): ArchitectureDiagnostic[] {
	const consumers = new Map<string, Set<string>>()
	for (const [file, targets] of dependencies) {
		const owner = moduleOwner(file) ?? ''
		if (!owner || owner === 'domain/shared') continue
		const visited = new Set<string>()
		function visit(target: string) {
			if (!target.startsWith('domain/shared/') || visited.has(target)) return
			visited.add(target)
			const owners = consumers.get(target) ?? new Set<string>()
			owners.add(owner)
			consumers.set(target, owners)
			for (const next of dependencies.get(target) ?? []) visit(next)
		}
		for (const target of targets) visit(target)
	}
	const diagnostics: ArchitectureDiagnostic[] = []
	for (const [file, owners] of consumers) {
		if (owners.size === 1)
			diagnostics.push({
				code: 'shared-owner',
				file,
				message: `This shared implementation is used only by ${[...owners][0]}. Move it into that module until another module needs it.`,
			})
	}
	return diagnostics
}
