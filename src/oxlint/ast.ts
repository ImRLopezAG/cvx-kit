import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import type { Context, ESTree, RuleMeta, Scope, Visitor } from '@oxlint/plugins'
import { z } from 'zod'
import { parseSync, type Node } from 'oxc-parser'
import { createResolver, resolveImport } from './architecture'

export const consumerOptions = z.object({ convexDir: z.string().min(1).default('convex') })

export function appFile(context: Context, filename = context.filename) {
	const requestedRoot = resolve(
		context.cwd,
		consumerOptions.parse(context.options[0] ?? {}).convexDir,
	)
	const root = existsSync(requestedRoot) ? realpathSync(requestedRoot) : requestedRoot
	const file = relative(root, existsSync(filename) ? realpathSync(filename) : filename)
		.split(sep)
		.join('/')
	return file === '..' || file.startsWith('../') || file.startsWith('/') ? null : file
}

export function imported(
	context: Context,
	node: ESTree.Node,
	active = new Set<ESTree.Node>(),
): { source: string; name: string } | null {
	if (active.has(node) || active.size > 32) return null
	active = new Set(active).add(node)
	if (
		node.type === 'TSAsExpression' ||
		node.type === 'TSSatisfiesExpression' ||
		node.type === 'TSNonNullExpression'
	)
		return imported(context, node.expression, active)
	if (node.type === 'CallExpression') return imported(context, node.callee, active)
	if (node.type === 'MemberExpression') {
		const owner = imported(context, node.object, active)
		const name = propertyName(node)
		return owner && name && ['*', 'z', 'v', 'default'].includes(owner.name)
			? { source: owner.source, name }
			: null
	}
	if (node.type !== 'Identifier') return null
	const initializer = localInitializer(context, node)
	if (
		initializer &&
		initializer.type !== 'CallExpression' &&
		initializer.type !== 'AwaitExpression'
	)
		return imported(context, initializer, active)
	const member = localDestructured(context, node)
	if (member) {
		const owner = imported(context, member.expression, active)
		return owner && ['*', 'z', 'v', 'default'].includes(owner.name)
			? { source: owner.source, name: member.name }
			: null
	}
	for (const def of binding(context, node)?.defs ?? []) {
		if (
			def.type !== 'ImportBinding' ||
			def.parent?.type !== 'ImportDeclaration' ||
			def.parent.importKind === 'type'
		)
			continue
		const specifier = def.node
		if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') continue
		return {
			source: def.parent.source.value,
			name:
				specifier.type === 'ImportSpecifier'
					? (exportName(specifier.imported) ?? '')
					: specifier.type === 'ImportDefaultSpecifier'
						? 'default'
						: '*',
		}
	}
	return null
}

/** Follow immutable bindings only; a same-named parameter never inherits outer provenance. */
export function localInitializer(context: Context, node: ESTree.Node): ESTree.Node | null {
	const variable = binding(context, node)
	if (!variable || variable.references.some((reference) => reference.isWrite() && !reference.init))
		return null
	const def = variable.defs.length === 1 ? variable.defs[0] : null
	return def?.type === 'Variable' &&
		def.parent?.type === 'VariableDeclaration' &&
		def.parent.kind === 'const' &&
		def.node.type === 'VariableDeclarator' &&
		def.node.id.type === 'Identifier'
		? def.node.init
		: null
}

export function localDestructured(context: Context, node: ESTree.Node) {
	const variable = binding(context, node)
	if (!variable || variable.references.some((reference) => reference.isWrite() && !reference.init))
		return null
	const def = variable.defs.length === 1 ? variable.defs[0] : null
	if (
		def?.type !== 'Variable' ||
		def.parent?.type !== 'VariableDeclaration' ||
		def.parent.kind !== 'const' ||
		def.node.type !== 'VariableDeclarator' ||
		def.node.id.type !== 'ObjectPattern' ||
		!def.node.init
	)
		return null
	for (const property of def.node.id.properties) {
		if (
			property.type === 'Property' &&
			property.value.type === 'Identifier' &&
			property.value.name === variable.name
		) {
			const name = property.computed ? staticString(property.key) : exportName(property.key)
			if (name) return { expression: def.node.init, name }
		}
	}
	return null
}

export type ReadProvenance =
	| 'table'
	| 'dtoSchema'
	| 'dto'
	| 'engine'
	| 'reader'
	| 'include'
	| 'context'
	| 'db'
	| 'stream'
	| 'relationship'
	| 'bounded'
	| 'page'
	| 'validator'
	| 'foundation'
	| 'queryRegistry'
	| 'queryOperation'

const nativeReadBuilders = ['query', 'internalQuery', 'mutation', 'internalMutation']

// Weak keys keep caches local to a lint invocation; no file state survives a new context.
const provenanceCaches = new WeakMap<
	Context,
	{
		nodes: Map<ESTree.Node, ReadProvenance | null>
		files: Map<string, ReturnType<typeof parseSync>>
		imports: Map<string, ReadProvenance | null>
		resolver: ReturnType<typeof createResolver>
	}
>()
/** Suspend dependencies on a work stack; null in-progress entries terminate alias cycles. */
export function readProvenance(context: Context, node: ESTree.Node): ReadProvenance | null {
	const cache = provenanceCache(context).nodes
	if (cache.has(node)) return cache.get(node) ?? null
	cache.set(node, null)
	const stack = [{ node, evaluation: evaluateReadProvenance(context, node) }]
	let result: ReadProvenance | null = null
	while (stack.length) {
		const frame = stack[stack.length - 1]!
		const step = frame.evaluation.next(result)
		if (step.done) {
			result = step.value
			cache.set(frame.node, result)
			stack.pop()
		} else if (cache.has(step.value)) {
			result = cache.get(step.value) ?? null
		} else {
			cache.set(step.value, null)
			stack.push({ node: step.value, evaluation: evaluateReadProvenance(context, step.value) })
			result = null
		}
	}
	return result
}
export function sourceVisitors(
	context: Context,
	check: (node: ESTree.Node, source: string) => void,
): Visitor {
	function visit(node: ESTree.Node, source: ESTree.Node | null | undefined) {
		const text = staticString(source)
		if (text) check(node, text)
	}
	return {
		ImportDeclaration(node) {
			visit(node, node.source)
		},
		ExportNamedDeclaration(node) {
			visit(node, node.source)
		},
		ExportAllDeclaration(node) {
			visit(node, node.source)
		},
		ImportExpression(node) {
			visit(node, node.source)
		},
		TSImportType(node) {
			visit(node, node.source)
		},
		CallExpression(node) {
			if (
				node.callee.type === 'Identifier' &&
				node.callee.name === 'require' &&
				!binding(context, node.callee)?.defs.length
			)
				visit(node, node.arguments[0])
		},
	}
}

export function isFunctionsImport(context: Context, source: string) {
	const target = source.startsWith('.')
		? resolve(dirname(context.filename), source)
		: resolveImport(createResolver(), context.filename, source)
	return target !== null && appFile(context, target)?.replace(/\.[cm]?[jt]s$/, '') === 'functions'
}

export function typeOnlySource(node: ESTree.Node) {
	return (
		node.type === 'TSImportType' ||
		(node.type === 'ImportDeclaration' &&
			(node.importKind === 'type' ||
				(node.specifiers.length > 0 &&
					node.specifiers.every(
						(specifier) => specifier.type === 'ImportSpecifier' && specifier.importKind === 'type',
					)))) ||
		((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
			node.exportKind === 'type')
	)
}

export function isDbAccess(node: ESTree.CallExpression) {
	return (
		node.callee.type === 'MemberExpression' &&
		node.callee.object.type === 'MemberExpression' &&
		propertyName(node.callee.object) === 'db'
	)
}

export function isExternalCall(context: Context, node: ESTree.CallExpression) {
	const ref = imported(context, node.callee)
	if (ref && /^(?:node:)?(?:https?|net|tls|fs)(?:\/|$)|^(?:undici|axios)(?:\/|$)/.test(ref.source))
		return true
	return (
		(node.callee.type === 'Identifier' &&
			node.callee.name === 'fetch' &&
			!binding(context, node.callee)?.defs.length) ||
		(node.callee.type === 'MemberExpression' &&
			propertyName(node.callee) === 'fetch' &&
			node.callee.object.type === 'Identifier' &&
			node.callee.object.name === 'globalThis' &&
			!binding(context, node.callee.object)?.defs.length)
	)
}

export function containsComponentReference(context: Context, node: ESTree.Node): boolean {
	if (node.type === 'MemberExpression') {
		const owner = imported(context, node.object)
		if (owner?.name === 'components' && /_generated\/api/.test(owner.source)) return true
		return containsComponentReference(context, node.object)
	}
	if (node.type === 'ObjectExpression')
		return node.properties.some(
			(property) =>
				property.type === 'Property' && containsComponentReference(context, property.value),
		)
	return false
}

export function rootMember(node: ESTree.Node): ESTree.Node {
	return node.type === 'MemberExpression' ? rootMember(node.object) : node
}

export function memberPath(node: ESTree.Node): string[] {
	if (node.type === 'Identifier') return [node.name]
	if (node.type === 'MemberExpression')
		return [...memberPath(node.object), propertyName(node) ?? '']
	return []
}

export function isTableChain(node: ESTree.Node): boolean {
	if (node.type === 'MemberExpression')
		return propertyName(node) === 'table' || isTableChain(node.object)
	return node.type === 'CallExpression' && isTableChain(node.callee)
}

export function isDbWrite(node: ESTree.CallExpression) {
	return (
		node.callee.type === 'MemberExpression' &&
		['insert', 'patch', 'replace', 'delete'].includes(propertyName(node.callee) ?? '') &&
		node.callee.object.type === 'MemberExpression' &&
		propertyName(node.callee.object) === 'db'
	)
}

export function hasCall(node: ESTree.Node, name: string): boolean {
	if (node.type === 'CallExpression')
		return (
			(node.callee.type === 'MemberExpression' &&
				propertyName(node.callee) === name &&
				(name !== 'query' || propertyName(node.callee.object) === 'db')) ||
			hasCall(node.callee, name)
		)
	if (node.type === 'MemberExpression') return hasCall(node.object, name)
	return false
}

export function metadata(description: string, messages: Record<string, string>): RuleMeta {
	return { type: 'problem', docs: { description }, schema: [], messages }
}

export function componentRoot(context: Context, filename: string) {
	const requestedRoot = resolve(
		context.cwd,
		consumerOptions.parse(context.options[0] ?? {}).convexDir,
	)
	const root = existsSync(requestedRoot) ? realpathSync(requestedRoot) : requestedRoot
	const file = relative(root, existsSync(filename) ? realpathSync(filename) : filename)
		.split(sep)
		.join('/')
	const match = file.match(/^components\/([^/]+)(?:\/|$)/)
	return match ? resolve(root, 'components', match[1]) : null
}

export function staticString(node: ESTree.Node | null | undefined) {
	if (node?.type === 'Literal' && 'value' in node && String(node.value) === node.value)
		return String(node.value)
	if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
		return node.quasis[0].value.cooked
	return null
}

export function propertyName(node: ESTree.Node): string | null {
	if (node.type !== 'MemberExpression') return null
	return node.computed ? staticString(node.property) : node.property.name
}

export function binding(context: Context, node: ESTree.Node) {
	if (node.type !== 'Identifier') return null
	let scope: Scope | null = context.sourceCode.getScope(node)
	while (scope) {
		const variable = scope.set.get(node.name)
		if (variable) return variable
		scope = scope.upper
	}
	return null
}

export function exportedNames(program: ESTree.Program) {
	const names = new Set<string>()
	for (const statement of program.body) {
		if (statement.type === 'ExportNamedDeclaration' && !statement.source) {
			for (const specifier of statement.specifiers) names.add(exportName(specifier.local) ?? '')
		} else if (
			statement.type === 'ExportDefaultDeclaration' &&
			statement.declaration.type === 'Identifier'
		) {
			names.add(statement.declaration.name)
		}
	}
	return names
}

export function exportName(node: ESTree.Node): string | null {
	return node.type === 'Identifier' ? node.name : staticString(node)
}

export function delegatingBody(node: ESTree.Node): boolean {
	if (node.type === 'CallExpression') return true
	if (node.type === 'AwaitExpression') return delegatingBody(node.argument)
	if (node.type === 'BlockStatement')
		return (
			node.body.length > 0 &&
			node.body.every(
				(statement) =>
					(statement.type === 'ReturnStatement' &&
						statement.argument !== null &&
						delegatingBody(statement.argument)) ||
					(statement.type === 'ExpressionStatement' && delegatingBody(statement.expression)),
			)
		)
	return false
}

/** Read only the owning schema/facade's top-level declaration, never arbitrary helper bodies. */
function importedReadProvenance(
	context: Context,
	ref: { source: string; name: string },
): ReadProvenance | null {
	const cache = provenanceCache(context)
	const target = resolveImport(cache.resolver, context.filename, ref.source)
	const file = target && appFile(context, target)
	if (
		!target ||
		!file ||
		!/^(?:domain\/.+\/schema\.ts|querying\.ts|foundation\.ts)$/.test(file) ||
		!existsSync(target)
	)
		return null
	const key = `${target}:${ref.name}`
	if (cache.imports.has(key)) return cache.imports.get(key) ?? null
	const result = physicalReadProvenance(context, target, ref.name)
	cache.imports.set(key, result)
	return result
}
function physicalReadProvenance(
	context: Context,
	target: string,
	name: string,
): ReadProvenance | null {
	const cache = provenanceCache(context)
	let parsed = cache.files.get(target)
	if (!parsed) {
		parsed = parseSync(target, readFileSync(target, 'utf8'))
		cache.files.set(target, parsed)
	}
	if (parsed.errors.length) return null
	const imports = new Map<string, { source: string; name: string }>()
	const declarations = new Map<string, Node>()
	const members = new Map<string, string>()
	const exports = new Map<string, string>()
	for (const statement of parsed.program.body) {
		if (statement.type === 'ImportDeclaration' && statement.importKind !== 'type') {
			for (const specifier of statement.specifiers) {
				if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type')
					imports.set(specifier.local.name, {
						source: statement.source.value,
						name: specifier.imported.type === 'Identifier' ? specifier.imported.name : '',
					})
				if (specifier.type === 'ImportNamespaceSpecifier')
					imports.set(specifier.local.name, { source: statement.source.value, name: '*' })
			}
		}
		const declaration =
			statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
		if (declaration?.type === 'VariableDeclaration' && declaration.kind === 'const') {
			for (const item of declaration.declarations) {
				if (!item.init) continue
				if (item.id.type === 'ObjectPattern') {
					for (const property of item.id.properties) {
						if (property.type !== 'Property' || property.value.type !== 'Identifier') continue
						const member = property.computed
							? physicalString(property.key)
							: property.key.type === 'Identifier'
								? property.key.name
								: null
						if (!member) continue
						declarations.set(property.value.name, item.init)
						members.set(property.value.name, member)
						if (statement.type === 'ExportNamedDeclaration')
							exports.set(property.value.name, property.value.name)
					}
				}
				if (item.id.type !== 'Identifier') continue
				declarations.set(item.id.name, item.init)
				if (statement.type === 'ExportNamedDeclaration') exports.set(item.id.name, item.id.name)
			}
		}
		if (
			statement.type === 'ExportNamedDeclaration' &&
			!statement.source &&
			statement.exportKind !== 'type'
		) {
			for (const specifier of statement.specifiers)
				if (
					specifier.exportKind !== 'type' &&
					specifier.local.type === 'Identifier' &&
					specifier.exported.type === 'Identifier'
				)
					exports.set(specifier.exported.name, specifier.local.name)
		}
	}
	const local = exports.get(name)
	if (!local) return null
	function factoryImport(
		node: Node,
		active = new Set<string>(),
	): { source: string; name: string } | null {
		if (node.type === 'Identifier') {
			if (active.has(node.name) || active.size > 16) return null
			const importedFactory = imports.get(node.name)
			if (importedFactory) return importedFactory
			const init = declarations.get(node.name)
			return init ? factoryImport(init, new Set(active).add(node.name)) : null
		}
		if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
			const owner = factoryImport(node.object, active)
			if (owner?.name === '*') return { source: owner.source, name: node.property.name }
		}
		return null
	}
	function evaluate(node: Node, active = new Set<string>()): ReadProvenance | null {
		if (
			node.type === 'TSAsExpression' ||
			node.type === 'TSSatisfiesExpression' ||
			node.type === 'ParenthesizedExpression'
		)
			return evaluate(node.expression, active)
		if (node.type === 'Identifier') {
			if (active.has(node.name) || active.size > 16) return null
			const init = declarations.get(node.name)
			const value = init ? evaluate(init, new Set(active).add(node.name)) : null
			return members.has(node.name)
				? value === 'foundation' && members.get(node.name) === 'Query'
					? 'queryRegistry'
					: null
				: value
		}
		if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier')
			return evaluate(node.object, active) === 'foundation' && node.property.name === 'Query'
				? 'queryRegistry'
				: null
		if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return null
		const factory = factoryImport(node.callee)
		if (factory && foundationFactory(factory)) return 'foundation'
		if (
			factory &&
			['cvx-kit', 'cvx-kit/zod-table', 'cvx-kit/tenancy'].includes(factory.source) &&
			['zodTable', 'tenantTable', 'zodVariantTable'].includes(factory.name)
		)
			return 'table'
		if (
			factory &&
			['cvx-kit', 'cvx-kit/querying'].includes(factory.source) &&
			factory.name === 'createQueryEngine'
		)
			return 'engine'
		return null
	}
	const declaration = declarations.get(local)
	const value = declaration ? evaluate(declaration) : null
	return members.has(local)
		? value === 'foundation' && members.get(local) === 'Query'
			? 'queryRegistry'
			: null
		: value
}

function provenanceCache(context: Context) {
	let cache = provenanceCaches.get(context)
	if (!cache) {
		cache = { nodes: new Map(), files: new Map(), imports: new Map(), resolver: createResolver() }
		provenanceCaches.set(context, cache)
	}
	return cache
}

function* evaluateReadProvenance(
	context: Context,
	node: ESTree.Node,
): Generator<ESTree.Node, ReadProvenance | null, ReadProvenance | null> {
	if (node.type === 'AwaitExpression') return yield node.argument
	if (
		node.type === 'TSAsExpression' ||
		node.type === 'TSSatisfiesExpression' ||
		node.type === 'TSNonNullExpression'
	)
		return yield node.expression
	if (node.type === 'Identifier') {
		const variable = binding(context, node)
		if (variable?.references.some((reference) => reference.isWrite() && !reference.init))
			return null
		const initializer = localInitializer(context, node)
		if (initializer) return yield initializer
		const member = localDestructured(context, node)
		if (member) {
			const owner = yield member.expression
			if (owner === 'context' && member.name === 'db') return 'db'
			if (owner === 'page' && member.name === 'page') return 'bounded'
			if (owner === 'table' && member.name === 'publicDto') return 'dtoSchema'
			if (owner === 'foundation' && member.name === 'Query') return 'queryRegistry'
		}
		const def = binding(context, node)?.defs[0]
		if (
			def?.type === 'Parameter' &&
			(def.node.type === 'ArrowFunctionExpression' || def.node.type === 'FunctionExpression')
		) {
			const callbackCall = def.node.parent
			if (
				callbackCall?.type === 'CallExpression' &&
				callbackCall.arguments[0] === def.node &&
				def.node.params[0] === def.name &&
				(callbackCall.callee.type === 'Identifier' ||
					callbackCall.callee.type === 'MemberExpression')
			) {
				const ref = imported(context, callbackCall.callee)
				if (ref && nativeReadBuilder(ref)) return 'context'
			}
			if (
				callbackCall?.type === 'CallExpression' &&
				callbackCall.callee.type === 'MemberExpression'
			) {
				const owner = yield callbackCall.callee.object
				const method = propertyName(callbackCall.callee)
				if (
					method === 'handler' &&
					owner === 'queryOperation' &&
					callbackCall.arguments[0] === def.node &&
					def.node.params[1] === def.name
				)
					return 'context'
				if (def.node.params[0] !== def.name) return null
				if (
					(method === 'execute' || method === 'paginate') &&
					callbackCall.arguments[1] === def.node &&
					(owner === 'stream' || owner === 'relationship')
				)
					return 'bounded'
				if (
					method === 'then' &&
					callbackCall.arguments[0] === def.node &&
					(owner === 'bounded' || owner === 'page')
				)
					return owner
			}
			const property = def.node.parent
			const object = property?.type === 'Property' ? property.parent : null
			const call = object?.type === 'ObjectExpression' ? object.parent : null
			const ref = call?.type === 'CallExpression' ? imported(context, call.callee) : null
			if (
				property?.type === 'Property' &&
				(property.computed ? staticString(property.key) : exportName(property.key)) ===
					'operations' &&
				call?.type === 'CallExpression' &&
				call.arguments[0] === object &&
				(yield call.callee) === 'queryRegistry' &&
				object?.type === 'ObjectExpression' &&
				def.node.params[0]?.type === 'ObjectPattern' &&
				def.node.params[0].properties.some(
					(p) =>
						p.type === 'Property' &&
						p.value === def.name &&
						(p.computed ? staticString(p.key) : exportName(p.key)) === 'query',
				) &&
				registryPreservesContext(context, object)
			)
				return 'queryOperation'

			if (
				property?.type === 'Property' &&
				(property.computed ? staticString(property.key) : exportName(property.key)) === 'handler' &&
				call?.type === 'CallExpression' &&
				call.arguments[0] === object &&
				def.node.params[1] === def.name &&
				(yield call.callee) === 'queryOperation'
			)
				return 'context'

			if (
				property?.type === 'Property' &&
				(property.computed ? staticString(property.key) : exportName(property.key)) === 'handler' &&
				def.node.params[0] === def.name &&
				ref &&
				((call?.type === 'CallExpression' &&
					call.arguments[0] === object &&
					(call.callee.type === 'Identifier' || call.callee.type === 'MemberExpression') &&
					nativeReadBuilder(ref)) ||
					(isFunctionsImport(context, ref.source) &&
						/^(?:auth|role|admin|system)(?:Query|Mutation)$/.test(ref.name)))
			)
				return 'context'
		}
		const ref = imported(context, node)
		if (
			ref &&
			['zod', 'zod/v4', 'convex/values'].includes(ref.source) &&
			['z', 'v', '*', 'default'].includes(ref.name)
		)
			return 'validator'
		if (ref) return importedReadProvenance(context, ref)
		return null
	}
	if (node.type === 'MemberExpression') {
		const ref = imported(context, node)
		if (ref) {
			const importedValue = importedReadProvenance(context, ref)
			if (importedValue) return importedValue
		}
		const owner = yield node.object
		const name = propertyName(node)
		if (owner === 'context' && name === 'db') return 'db'
		if (owner === 'foundation' && name === 'Query') return 'queryRegistry'
		if (owner === 'reader') return 'stream'
		if (owner === 'page' && name === 'page') return 'bounded'
		if (owner === 'table' && ['publicDto', 'dto'].includes(name ?? '')) return 'dtoSchema'
		if (owner === 'validator') return 'validator'
		return null
	}
	if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return null
	const callee = yield node.callee
	if (callee === 'engine') return 'reader'
	if (callee === 'include' && node.arguments[0] && (yield node.arguments[0]) === 'stream')
		return 'stream'
	const ref = imported(context, node.callee)
	if (ref && foundationFactory(ref)) return 'foundation'
	if (
		ref &&
		['cvx-kit', 'cvx-kit/zod-table', 'cvx-kit/tenancy'].includes(ref.source) &&
		['zodTable', 'tenantTable', 'zodVariantTable'].includes(ref.name)
	)
		return 'table'
	if (
		ref &&
		['cvx-kit', 'cvx-kit/querying'].includes(ref.source) &&
		ref.name === 'createQueryEngine'
	)
		return 'engine'
	if (ref && ['cvx-kit', 'cvx-kit/auth'].includes(ref.source) && ref.name === 'createInclude')
		return 'include'
	if (
		ref?.source === 'convex-helpers/server/stream' &&
		ref.name === 'stream' &&
		node.arguments[0] &&
		(yield node.arguments[0]) === 'db'
	)
		return 'db'
	if (node.callee.type !== 'MemberExpression') return null
	const owner = yield node.callee.object
	const name = propertyName(node.callee)
	if (owner === 'table' && name === 'toPublicDto') return 'dto'
	if (owner === 'table' && ['select', 'dto'].includes(name ?? '')) return 'dtoSchema'
	if (owner === 'dtoSchema' && ['parse', 'parseAsync'].includes(name ?? '')) return 'dto'
	if (owner === 'db' && name === 'query') return 'stream'
	if (owner === 'stream' && name === 'relation') return 'relationship'
	if (
		owner === 'context' &&
		name === 'include' &&
		node.arguments[0] &&
		(yield node.arguments[0]) === 'stream'
	)
		return 'stream'
	if (owner === 'stream' || owner === 'relationship') {
		if (['take', 'execute'].includes(name ?? '')) return 'bounded'
		if (name === 'paginate') return 'page'
		if (
			[
				'withIndex',
				'withSearchIndex',
				'filter',
				'filterWith',
				'map',
				'flatMap',
				'distinct',
				'order',
				'matching',
				'when',
				'otherwise',
				'fullTableScan',
				'where',
				'with',
			].includes(name ?? '')
		)
			return owner
	}
	if (owner === 'bounded' && name === 'map') return 'bounded'
	if (owner === 'validator') return 'validator'
	return null
}

/** Match native registration contracts by both their import source and exported name. */
function nativeReadBuilder(ref: { source: string; name: string }) {
	return (
		(/_generated\/server(?:\.[cm]?[jt]s)?$/.test(ref.source) &&
			nativeReadBuilders.includes(ref.name)) ||
		(ref.source === 'convex/server' &&
			nativeReadBuilders.some((name) => ref.name === `${name}Generic`))
	)
}

function foundationFactory(ref: { source: string; name: string }) {
	return (
		(ref.source === 'cvx-kit' && ref.name === 'createFoundation') ||
		(ref.source === 'cvx-kit/effect' && ref.name === 'createEffectFoundation') ||
		(['cvx-kit', 'cvx-kit/components/foundation'].includes(ref.source) && ref.name === 'Foundation')
	)
}

/** The supported registry mapping passes the host through unchanged. */
function registryPreservesContext(context: Context, object: ESTree.ObjectExpression) {
	const property = object.properties.find(
		(p) =>
			p.type === 'Property' && (p.computed ? staticString(p.key) : exportName(p.key)) === 'context',
	)
	if (property?.type !== 'Property') return false
	const callback = property.value
	if (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression')
		return false
	const host = callback.params[0]
	if (
		host?.type !== 'Identifier' ||
		binding(context, host)?.references.some((r) => r.isWrite() && !r.init)
	)
		return false
	const body = callback.body
	const returned =
		body?.type === 'BlockStatement' &&
		body.body.length === 1 &&
		body.body[0].type === 'ReturnStatement'
			? body.body[0].argument
			: body
	return returned?.type === 'Identifier' && binding(context, returned) === binding(context, host)
}

function physicalString(node: Node): string | null {
	if (node.type === 'Literal' && String(node.value) === node.value) return String(node.value)
	if (node.type === 'TemplateLiteral' && node.expressions.length === 0)
		return node.quasis[0].value.cooked
	return null
}
