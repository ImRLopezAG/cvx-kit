// One file through the v2 codemod. Every top-level statement is a unit; units
// whose schemas reference each other form a component, and a component with any
// unsupported site stays Zod byte for byte while the rest is rewritten.
import {
	applyEdits,
	chainOf,
	isReference,
	isShadowed,
	lineIndex,
	parentMap,
	parseSource,
	patternNames,
	resolveBinding,
	unwrap,
	walk,
} from './transforms/ast.mjs'
import {
	alwaysRewritten,
	collectImports,
	KIT_RENAMES,
	planImports,
	ZOD_INTEROP,
} from './transforms/imports.mjs'
import {
	carriesObjectChecks,
	isSchemaExpression,
	isTableExpression,
	processBoundChain,
	processZodChain,
	SCHEMA_METHODS,
} from './transforms/schema.mjs'
import {
	consumerOrigin,
	contractDefinition,
	isDomainContractCallee,
	isRegistrationCallee,
} from './transforms/consumer.mjs'
import { getterEdits, isFunctionDefinition } from './transforms/getters.mjs'
import { addEdit, addInfo, addManual, addSkip } from './transforms/sites.mjs'
import { isCreateTable, processTableCall, tableKind } from './transforms/tables.mjs'
import { prepareGenericHelpers, processZodType } from './transforms/types.mjs'

export const KEEP_MARKER = 'cvx-kit-codemod: keep-zod'
// The marker, optionally followed by a reason: `// cvx-kit-codemod: keep-zod -- SDK needs Zod`.
const KEEP_COMMENT = /^cvx-kit-codemod: keep-zod(?:\s|$)/

// Kit functions whose arguments are schemas, so v1 and v2 schemas cannot meet in them.
const SCHEMA_ARGUMENT_FUNCTIONS = new Set([
	'paginated',
	'zodContract',
	'effectZodApiBuilder',
	'createTable',
])

const JS_GLOBALS = new Set([
	'Object',
	'Function',
	'Boolean',
	'Symbol',
	'Number',
	'BigInt',
	'Math',
	'Date',
	'String',
	'RegExp',
	'Array',
	'Map',
	'Set',
	'WeakMap',
	'WeakSet',
	'Promise',
	'Reflect',
	'Proxy',
	'JSON',
	'Intl',
	'Error',
	'TypeError',
	'RangeError',
	'ArrayBuffer',
	'SharedArrayBuffer',
	'DataView',
	'Uint8Array',
	'Uint16Array',
	'Uint32Array',
	'Int8Array',
	'Int16Array',
	'Int32Array',
	'Float32Array',
	'Float64Array',
	'BigInt64Array',
	'BigUint64Array',
	'structuredClone',
	'parseInt',
	'parseFloat',
	'isNaN',
	'isFinite',
	'globalThis',
	'encodeURI',
	'encodeURIComponent',
	'decodeURI',
	'decodeURIComponent',
	'Atomics',
	'WeakRef',
	'FinalizationRegistry',
	'EvalError',
	'URIError',
	'SyntaxError',
	'ReferenceError',
	'AggregateError',
	'Iterator',
	'AsyncIterator',
	'Uint8ClampedArray',
	'Float16Array',
	'eval',
])

const TYPE_DECLARATIONS = new Set(['TSTypeAliasDeclaration', 'TSInterfaceDeclaration'])

/**
 * `options.getters` (default `true`): rewrite `args` / `returns` of function
 * definitions to getters, see `transforms/getters.mjs`.
 * `options.nativeNumberBounds` (default `false`): emit `k.number()` instead of
 * `k.number().finite()`, and report each site that now accepts NaN and infinities.
 * `options.run`: what the CLI knows about the other files of the run, see
 * `index.mjs`; without it only this file is known.
 */
export function transformSource(path, source, options = {}) {
	let parsed
	try {
		parsed = parseSource(path, source)
	} catch (error) {
		return failure(path, source, error.message)
	}
	if (parsed.errors.length > 0) return failure(path, source, parsed.errors[0].message)
	if (parsed.comments.some((comment) => KEEP_COMMENT.test(comment.value.trim()))) {
		return keptByMarker(path, source, parsed.program, options)
	}
	try {
		return rewrite(path, source, parsed.program, {
			getters: options.getters !== false,
			nativeNumberBounds: options.nativeNumberBounds === true,
			run: options.run ?? null,
			deferForeign: options.deferForeign === true,
		})
	} catch (error) {
		return failure(path, source, error.message)
	}
}

function result(path, output, status, fields = {}) {
	return {
		path,
		status,
		rewritten: 0,
		skipped: [],
		info: [],
		declarations: { rewritten: 0, left: 0 },
		facts: null,
		output,
		...fields,
	}
}

function failure(path, source, message) {
	return result(path, source, 'error', { error: message })
}

function createContext(path, source, program, options) {
	return {
		path,
		options,
		source,
		program,
		parents: parentMap(program),
		position: lineIndex(source),
		zodNamespaces: new Set(),
		zodNamed: new Set(),
		zodDecls: [],
		zodRefs: new Map(),
		kit: new Map(),
		kitRootDecl: null,
		hasK: false,
		kConflict: null,
		kTypeImport: null,
		v2Tables: new Set(),
		imported: new Map(),
		moduleDecls: new Map(),
		schemaBindings: new Set(),
		schemaFactories: new Set(),
		schemaPaths: new Set(),
		refinedBindings: new Set(),
		numberBindings: new Set(),
		integerBindings: new Set(),
		tableBindings: new Set(),
		tablePaths: new Set(),
		tableFactories: new Set(),
		objectConsts: new Set(),
		owners: new Map(),
	}
}

function createUnit(node, index) {
	const declaration = node.type.startsWith('Export') && node.declaration ? node.declaration : node
	return {
		node,
		index,
		declaration,
		isType: TYPE_DECLARATIONS.has(declaration.type),
		edits: [],
		skips: [],
		info: [],
		contexts: [],
		refs: [],
		zidRefs: [],
		safeResults: new Set(),
		kitEdits: [],
		manual: [],
		zodValue: false,
		zodRefs: 0,
		tableCall: false,
		boundSchema: false,
		kitRefs: 0,
		getterEdits: [],
	}
}

function declaredNames(declaration) {
	if (declaration.type === 'VariableDeclaration') {
		return declaration.declarations.flatMap((declarator) => patternNames(declarator.id))
	}
	return declaration.id?.type === 'Identifier' ? [declaration.id.name] : []
}

function rewrite(path, source, program, options) {
	const ctx = createContext(path, source, program, options)
	collectImports(ctx)
	const units = program.body
		.filter((node) => node.type !== 'ImportDeclaration')
		.map((node, index) => createUnit(node, index))
	for (const unit of units) {
		for (const name of declaredNames(unit.declaration)) {
			if (!ctx.owners.has(name)) ctx.owners.set(name, [])
			ctx.owners.get(name).push(unit)
			if (name === 'k') ctx.kConflict ??= unit.declaration
		}
	}
	classifyBindings(ctx, units)
	prepareGenericHelpers(ctx, units)
	for (const unit of units) scanUnit(ctx, unit)
	for (const unit of units) scanConsumers(ctx, unit)
	walk(program, (node) => {
		const value =
			node.type === 'Literal'
				? node.value
				: node.type === 'TemplateLiteral' && node.expressions.length === 0
					? node.quasis[0].value.cooked
					: null
		if (value !== 'cvx-kit/zod-table' && value !== 'zid' && !KIT_RENAMES.has(value)) return
		if (ctx.parents.get(node)?.type === 'ImportDeclaration') return
		const unit = units.find((item) => item.node.start <= node.start && node.end <= item.node.end)
		if (unit) addManual(ctx, unit, node, 'v1-entry-string')
	})
	if (options.getters) for (const unit of units) unit.getterEdits = getterEdits(unit.node)
	const left = decideComponents(ctx, units)
	if (ctx.kConflict && units.some((unit) => unit.edits.length > 0)) {
		const skipped = [{ ...siteAt(ctx, ctx.kConflict), code: 'k-conflict' }]
		return result(path, source, 'untouched', { skipped })
	}
	const isLeft = (unit) => left.has(unit)
	for (const unit of units) {
		if (!isLeft(unit)) continue
		checkHeldPipes(ctx, unit)
		for (const binding of ctx.kit.values()) {
			if (binding.imported !== 'zodToConvex') continue
			for (const reference of binding.references ?? []) {
				if (
					reference.unit === unit.index &&
					binding.convertedCalls?.has(ctx.parents.get(reference.node))
				) {
					binding.bridgeUnknown = true
					addManual(ctx, unit, ctx.parents.get(reference.node), 'zod-to-convex-unknown')
				}
			}
		}
		for (const node of unit.zidRefs) {
			const binding = ctx.kit.get(node.name)
			if (binding?.imported === 'zid' && binding.module === 'cvx-kit/zod-table')
				addManual(ctx, unit, node, 'zid-in-zod-statement')
		}
	}
	const facts = factsOf(ctx, units, isLeft)
	const editsOf = (unit) =>
		isLeft(unit) ? [] : [...unit.edits, ...unit.getterEdits, ...unit.kitEdits]
	const applied = units.filter((unit) => !isLeft(unit) && editsOf(unit).length > 0)
	const needsK = applied.some((unit) => unit.edits.some((edit) => edit.usesK))
	const imports = planImports(ctx, (index) => isLeft(units[index]), needsK)
	const importSkips = []
	for (const decl of program.body) {
		if (decl.type !== 'ImportDeclaration' || decl.source.value !== 'cvx-kit/zod-table') continue
		const bindings = [...ctx.kit.values()].filter((binding) => binding.decl === decl)
		const unhandled =
			decl.specifiers.length === 0 ||
			bindings.length !== decl.specifiers.length ||
			bindings.some(
				(binding) =>
					ZOD_INTEROP.has(binding.imported) &&
					!binding.refs.some((index) => isLeft(units[index])) &&
					!(
						binding.imported === 'zodToConvex' &&
						!binding.bridgeUnknown &&
						binding.refs.every((index) => binding.converted?.has(index))
					),
			)
		if (unhandled) importSkips.push({ ...siteAt(ctx, decl.source), code: 'v1-entry-string' })
	}
	ctx.importSkips = importSkips
	const edits = [...units.flatMap(editsOf), ...imports.edits]
	const genericTypes = new Set(
		units
			.filter((unit) => !isLeft(unit))
			.flatMap((unit) => [...(unit.genericTypes ?? [])])
			.filter(
				(name) =>
					!(
						ctx.imported.get(name)?.source === 'cvx-kit/k' &&
						ctx.imported.get(name)?.imported === name
					),
			),
	)
	if (genericTypes.size > 0)
		edits.push({
			start: 0,
			end: 0,
			text: `import type { ${[...genericTypes].join(', ')} } from 'cvx-kit/k'\n`,
		})
	removeUsedMasks(ctx, units, edits)

	if (edits.length === 0) return summarize(path, source, ctx, units, isLeft, source, facts)
	const output = applyEdits(source, edits)
	const mixed =
		imports.zodRemains ||
		imports.oldKitRemains ||
		units.some((unit) => isLeft(unit) && counted(unit))
	return summarize(
		path,
		source,
		ctx,
		units,
		isLeft,
		output,
		facts,
		mixed ? 'mixed' : 'rewritten',
		applied.length,
	)
}

function checkHeldPipes(ctx, unit) {
	walk(unit.node, (node) => {
		if (
			node.type !== 'CallExpression' ||
			node.callee.type !== 'MemberExpression' ||
			node.callee.computed ||
			node.callee.property.name !== 'pipe'
		)
			return
		const argument = unwrap(node.arguments[0])
		if (argument?.type !== 'Identifier') return
		const binding = resolveBinding(argument, ctx.parents)
		if (
			binding?.kind === 'import' &&
			ctx.options.run?.isK(ctx.path, binding.source, binding.imported)
		)
			addManual(ctx, unit, node, 'held-pipe-to-k')
	})
}

/**
 * What other files of a run need to know about this one: the exported names that
 * are `k` schemas or tables once it is written. `index.mjs` resolves these across the run.
 */
function factsOf(ctx, units, isLeft) {
	const kLocals = new Set()
	for (const unit of units) {
		if (isLeft(unit)) continue
		for (const name of declaredNames(unit.declaration)) {
			if (ctx.schemaBindings.has(name) || ctx.tableBindings.has(name)) kLocals.add(name)
		}
	}
	const exports = new Map()
	for (const unit of units) {
		if (unit.node.type !== 'ExportNamedDeclaration') continue
		if (unit.node.declaration) {
			for (const name of declaredNames(unit.node.declaration)) exports.set(name, name)
		} else if (!unit.node.source) {
			for (const spec of unit.node.specifiers) {
				const exported =
					spec.exported.type === 'Identifier' ? spec.exported.name : spec.exported.value
				if (spec.local.type === 'Identifier') exports.set(exported, spec.local.name)
			}
		}
	}
	const kExports = [...exports].filter(([, local]) => kLocals.has(local)).map(([name]) => name)
	for (const [exported, local] of exports) {
		if (ctx.owners.get(local)?.some(isLeft)) continue
		for (const path of ctx.schemaPaths)
			if (path === local || path.startsWith(`${local}.`))
				kExports.push(`${exported}${path.slice(local.length)}`)
	}
	const tableExports = [...exports]
		.filter(([, local]) => kLocals.has(local) && ctx.tableBindings.has(local))
		.map(([name]) => name)
	for (const [exported, local] of exports) {
		if (ctx.owners.get(local)?.some(isLeft)) continue
		for (const path of ctx.tablePaths)
			if (path.startsWith(`${local}.`)) tableExports.push(exported + path.slice(local.length))
	}
	return { kExports, tableExports }
}

function siteAt(ctx, node) {
	const { line, column } = ctx.position(node.start)
	return {
		line,
		column,
		text: ctx.source.slice(node.start, node.end).replace(/\s+/g, ' ').slice(0, 80),
	}
}

function counted(unit) {
	return (
		!unit.isType &&
		(unit.zodValue || unit.tableCall || unit.boundSchema || unit.edits.some((edit) => edit.usesK))
	)
}

function summarize(
	path,
	source,
	ctx,
	units,
	isLeft,
	output,
	facts,
	status = 'untouched',
	rewritten = 0,
) {
	const skipped = [...(ctx.importSkips ?? [])]
	const info = []
	const declarations = { rewritten: 0, left: 0 }
	for (const unit of units) {
		skipped.push(...unit.manual)
		if (isLeft(unit)) skipped.push(...unit.skips)
		else info.push(...unit.info)
		if (!counted(unit)) continue
		if (isLeft(unit)) declarations.left++
		else if (unit.edits.length > 0 || unit.kitEdits.length > 0 || unit.getterEdits.length > 0)
			declarations.rewritten++
	}
	skipped.sort((left, right) => left.line - right.line || left.column - right.column)
	info.sort((left, right) => left.line - right.line || left.column - right.column)
	const remainingZod = units.some(
		(unit) => isLeft(unit) && (counted(unit) || (ctx.hasK && unit.zodRefs > 0)),
	)
	const noChangeStatus = remainingZod
		? ctx.hasK || ctx.v2Tables.size > 0
			? 'mixed'
			: 'kept'
		: 'untouched'
	const onlyZod =
		remainingZod &&
		!ctx.hasK &&
		ctx.v2Tables.size === 0 &&
		!units.some((unit) => !isLeft(unit) && unit.edits.some((edit) => edit.usesK))
	return result(path, output, output === source ? noChangeStatus : onlyZod ? 'kept' : status, {
		rewritten,
		skipped,
		info,
		declarations,
		facts,
	})
}

/** A chain rooted at `z.number()`/`z.int()` (or a binding of one) whose steps keep it a number. */
function isZodNumber(ctx, chain) {
	const { root, steps } = chain
	if (root.type !== 'Identifier') return false
	const numeric = ctx.zodNamespaces.has(root.name)
		? steps[0]?.kind === 'member' && (steps[0].name === 'number' || steps[0].name === 'int')
		: ctx.numberBindings.has(root.name)
	return (
		numeric &&
		!steps.some(
			(step) => step.kind === 'member' && (step.name === 'transform' || step.name === 'pipe'),
		)
	)
}

/** Top-level `const` bindings the codemod can prove are schemas, tables or table factories. */
function classifyBindings(ctx, units) {
	const bindings = [
		ctx.schemaBindings,
		ctx.schemaFactories,
		ctx.schemaPaths,
		ctx.tableBindings,
		ctx.tablePaths,
		ctx.tableFactories,
		ctx.refinedBindings,
		ctx.numberBindings,
		ctx.integerBindings,
		ctx.objectConsts,
	]
	const size = () => bindings.reduce((total, set) => total + set.size, 0)
	for (let pass = 0; pass <= units.length; pass++) {
		const before = size()
		for (const unit of units) {
			if (unit.declaration.type === 'FunctionDeclaration') {
				const fn = unit.declaration
				const only = fn.body?.body.length === 1 ? fn.body.body[0] : null
				if (!fn.async && only?.type === 'ReturnStatement' && isSchemaExpression(ctx, only.argument))
					ctx.schemaFactories.add(fn.id.name)
			}
			if (unit.declaration.type !== 'VariableDeclaration') continue
			for (const declarator of unit.declaration.declarations) {
				if (declarator.id.type === 'ObjectPattern' && declarator.init) {
					for (const name of patternNames(declarator.id)) {
						const binding = resolveBinding(declarator.id, ctx.parents, name)
						if (binding?.path) collectSchemaPaths(ctx, declarator.init, name, binding.path)
					}
				}
				if (declarator.id.type !== 'Identifier' || !declarator.init) continue
				const name = declarator.id.name
				const init = unwrap(declarator.init)
				if (isTableExpression(ctx, init)) ctx.tableBindings.add(name)
				if (init.type === 'CallExpression' && init.callee.type === 'Identifier') {
					const imported = ctx.imported.get(init.callee.name)
					const fields = unwrap(init.arguments[0])
					if (
						imported?.imported === 'defineRelations' &&
						['cvx-kit', 'cvx-kit/relations'].includes(imported.source) &&
						fields?.type === 'ObjectExpression'
					) {
						for (const property of fields.properties)
							if (
								property.type === 'Property' &&
								!property.computed &&
								isTableExpression(ctx, property.value)
							)
								ctx.tablePaths.add(`${name}.tables.${property.key.name ?? property.key.value}`)
					}
				}
				collectSchemaPaths(ctx, init, name)
				if (init.type === 'ObjectExpression' && unit.declaration.kind === 'const') {
					ctx.objectConsts.add(name)
				}
				if (init.type === 'CallExpression' && tableKind(ctx, init)) ctx.tableBindings.add(name)
				else if (init.type === 'CallExpression' && isCreateTable(ctx, init))
					ctx.tableFactories.add(name)
				else if (isSchemaExpression(ctx, init)) {
					ctx.schemaBindings.add(name)
					if (carriesObjectChecks(ctx, chainOf(init))) ctx.refinedBindings.add(name)
					const chain = chainOf(init)
					if (isZodNumber(ctx, chain)) {
						ctx.numberBindings.add(name)
						if (
							ctx.integerBindings.has(chain.root.name) ||
							chain.steps.some(
								(step) => step.kind === 'member' && (step.name === 'int' || step.name === 'safe'),
							)
						)
							ctx.integerBindings.add(name)
					}
				}
			}
		}
		if (size() === before) break
	}
}

/** Record schema leaves in literal objects and contract definitions, never arbitrary calls. */
function collectSchemaPaths(ctx, expression, path, selected = [], seen = new Set()) {
	const node = unwrap(expression)
	if (!node || seen.has(node)) return
	seen = new Set(seen).add(node)
	if (node.type === 'MemberExpression' && (!node.computed || node.property.type === 'Literal')) {
		collectSchemaPaths(
			ctx,
			node.object,
			path,
			[node.property.name ?? node.property.value, ...selected],
			seen,
		)
		return
	}
	if (node.type === 'Identifier') {
		const binding = resolveBinding(node, ctx.parents)
		const prefix = [node.name, ...selected].join('.')
		for (const known of [...ctx.schemaPaths, ...ctx.schemaBindings]) {
			if (known === prefix || known.startsWith(`${prefix}.`))
				ctx.schemaPaths.add(path + known.slice(prefix.length))
		}
		if (binding?.kind === 'import') {
			const imported =
				binding.imported === '*' ? selected.join('.') : [binding.imported, ...selected].join('.')
			for (const suffix of ctx.options.run?.schemaPaths?.(ctx.path, binding.source, imported) ?? [])
				ctx.schemaPaths.add(path + suffix)
		} else if (binding?.kind === 'const' && binding.path) {
			collectSchemaPaths(ctx, binding.init, path, [...binding.path, ...selected], seen)
		}
		return
	}
	if (selected.length > 0 && node.type !== 'ObjectExpression' && node.type !== 'CallExpression')
		return
	if (isSchemaExpression(ctx, node)) {
		if (selected.length === 0) ctx.schemaPaths.add(path)
		return
	}
	if (node.type === 'CallExpression' && isDomainContractCallee(ctx, node.callee)) {
		collectSchemaPaths(ctx, contractDefinition(node.arguments[0]), path, selected, seen)
		return
	}
	if (node.type !== 'ObjectExpression') return
	for (const property of node.properties) {
		if (property.type !== 'Property' || property.computed || property.kind !== 'init') continue
		const key = property.key.name ?? property.key.value
		if (selected.length > 0) {
			if (selected[0] === key)
				collectSchemaPaths(ctx, property.value, path, selected.slice(1), seen)
		} else collectSchemaPaths(ctx, property.value, `${path}.${key}`, [], seen)
	}
}

function scanUnit(ctx, unit) {
	if (unit.declaration.type === 'VariableDeclaration')
		for (const item of unit.declaration.declarations)
			if (
				item.init &&
				(isSchemaExpression(ctx, item.init) ||
					[...ctx.schemaPaths].some((path) => path.startsWith(`${item.id.name}.`)))
			)
				unit.contexts.push(item.init)
	const identifiers = []
	const calls = []
	walk(
		unit.node,
		(node, parent) => {
			if (node.type === 'Identifier') identifiers.push([node, parent])
			else if (node.type === 'CallExpression') calls.push(node)
		},
		ctx.program,
	)
	for (const call of calls) {
		if (call.callee.type === 'Identifier' && ctx.genericHelpers?.has(call.callee.name))
			unit.contexts.push(call)
		const kind = tableKind(ctx, call)
		if (kind) processTableCall(ctx, unit, call)
	}
	scanForeignSchemas(ctx, unit)
	for (const call of calls) unprovenSchemaCall(ctx, unit, call)
	walk(unit.node, (node) => {
		if (node.type !== 'SpreadElement' || node.argument.type !== 'Identifier') return
		if (ctx.tableBindings.has(node.argument.name)) addInfo(ctx, unit, node, 'table-spread')
	})
	for (const [node, parent] of identifiers) {
		if (!isReference(node, parent)) continue
		const name = node.name
		if (isShadowed(node, name, ctx.parents)) continue
		if (ctx.zodNamespaces.has(name)) zodReference(ctx, unit, node, parent)
		else if (ctx.zodNamed.has(name)) {
			countZodRef(ctx, unit, name)
			addSkip(ctx, unit, node, 'zod-type')
		} else if (ctx.kit.has(name)) kitReference(ctx, unit, node, parent)
		if (ctx.kit.get(name)?.imported === 'zid') unit.zidRefs.push(node)
		if (ctx.owners.has(name)) unit.refs.push(node)
		const member = parent?.type === 'MemberExpression' && parent.object === node
		if (!member) continue
		const imported = ctx.imported.get(name)
		const external = imported && !ctx.owners.get(name)?.some((owner) => !owner.isType)
		if (
			ctx.tableBindings.has(name) ||
			(external && ctx.options.run?.isTable(ctx.path, imported.source, imported.imported))
		)
			processBoundChain(ctx, unit, node, true)
		else processBoundChain(ctx, unit, node, false)
	}
	if (unit.safeResults.size === 0) return
	walk(unit.node, (node) => {
		if (node.type !== 'MemberExpression' || node.computed) return
		if (node.object.type !== 'Identifier' || !unit.safeResults.has(node.object.name)) return
		if (node.property.name === 'error') addSkip(ctx, unit, node, 'zod-introspection')
	})
}

/**
 * Zod-only spellings (a `{ key: true }` mask on `pick`/`omit`) on a
 * chain whose root the codemod cannot prove is a schema or a table: reported,
 * not rewritten, and the unit's other sites are unaffected.
 */
function unprovenSchemaCall(ctx, unit, call) {
	const callee = call.callee
	if (callee.type !== 'MemberExpression' || callee.computed) return
	const name = callee.property.name
	const mask =
		['pick', 'omit', 'partial', 'required'].includes(name) &&
		call.arguments.length === 1 &&
		['ObjectExpression', 'Identifier', 'MemberExpression'].includes(unwrap(call.arguments[0]).type)
	if (!mask) return
	if (isSchemaExpression(ctx, callee.object)) return
	const { root } = chainOf(callee.object)
	if (root.type === 'Identifier') {
		if (ctx.zodNamespaces.has(root.name)) return
	}
	addManual(ctx, unit, { start: callee.property.start, end: call.end }, 'unproven-mask')
}

function countZodRef(ctx, unit, name) {
	unit.zodRefs++
	if (!ctx.zodRefs.has(name)) ctx.zodRefs.set(name, [])
	ctx.zodRefs.get(name).push(unit.index)
}

function zodReference(ctx, unit, node, parent) {
	countZodRef(ctx, unit, node.name)
	if (parent?.type === 'MemberExpression' && parent.object === node)
		processZodChain(ctx, unit, node)
	else if (parent?.type === 'TSQualifiedName' && parent.left === node)
		processZodType(ctx, unit, node, parent)
	else addSkip(ctx, unit, node, 'unknown-factory')
}

function kitReference(ctx, unit, node, parent) {
	const binding = ctx.kit.get(node.name)
	binding.refs.push(unit.index)
	binding.references ??= []
	binding.references.push({ node, unit: unit.index })
	unit.kitRefs++
	const called = parent?.type === 'CallExpression' && parent.callee === node
	if (called && SCHEMA_ARGUMENT_FUNCTIONS.has(binding.imported)) unit.contexts.push(parent)
	if (binding.imported === 'zodToConvex' || binding.imported === 'convexToZod') {
		const argument = called ? parent.arguments[0] : null
		if (
			binding.imported === 'zodToConvex' &&
			parent.arguments?.length === 1 &&
			isSchemaExpression(ctx, argument)
		) {
			binding.converted ??= new Set()
			binding.converted.add(unit.index)
			binding.convertedCalls ??= new Set()
			binding.convertedCalls.add(parent)
			unit.contexts.push(parent)
			const simple = argument.type === 'Identifier' || argument.type === 'MemberExpression'
			addEdit(unit, { start: parent.start, end: argument.start }, simple ? '' : '(')
			addEdit(unit, { start: argument.end, end: parent.end }, simple ? '.validator' : ').validator')
		} else {
			binding.bridgeUnknown = true
			addManual(
				ctx,
				unit,
				called ? parent : node,
				binding.imported === 'convexToZod' ? 'convex-to-zod' : 'zod-to-convex-unknown',
			)
		}
		return
	}
	if (ZOD_INTEROP.has(binding.imported)) {
		addSkip(ctx, unit, called ? parent : node, 'zod-interop')
		return
	}
	if (binding.imported === 'zid') {
		if (called) addEdit(unit, node, 'k.id', true)
		else addSkip(ctx, unit, node, 'zid-value')
		return
	}
	const renamed = KIT_RENAMES.get(binding.imported)
	if (!renamed || binding.local !== binding.imported) return
	// A kit name is renamed in every unit: its v1 module no longer exists in v2.
	if (alwaysRewritten(binding))
		unit.kitEdits.push({ start: node.start, end: node.end, text: renamed })
	else addEdit(unit, node, renamed)
}

/**
 * Union units whose schemas meet: a schema context (Zod chain, kit call, type
 * helper) referencing another schema unit, and every use of a kit binding that
 * keeps its local name across v1 and v2. Returns the units left as Zod.
 */
function decideComponents(ctx, units) {
	const root = units.map((_, index) => index)
	const find = (index) => {
		while (root[index] !== index) {
			root[index] = root[root[index]]
			index = root[index]
		}
		return index
	}
	const union = (left, right) => {
		root[find(left)] = find(right)
	}
	const schemaUnit = (unit) =>
		unit.zodRefs > 0 ||
		unit.tableCall ||
		unit.kitRefs > 0 ||
		unit.boundSchema ||
		unit.edits.length > 0 ||
		unit.skips.length > 0 ||
		declaredNames(unit.declaration).some(
			(name) =>
				ctx.schemaBindings.has(name) ||
				ctx.tableBindings.has(name) ||
				ctx.tableFactories.has(name) ||
				[...ctx.schemaPaths].some((path) => path.startsWith(`${name}.`)),
		)
	const linkedBy = new Map()
	for (const unit of units) {
		if (unit.contexts.length === 0) continue
		for (const ref of unit.refs) {
			if (!unit.contexts.some((context) => context.start <= ref.start && ref.end <= context.end))
				continue
			for (const owner of ctx.owners.get(ref.name)) {
				if (owner === unit || !schemaUnit(owner)) continue
				union(unit.index, owner.index)
				if (!linkedBy.has(unit)) linkedBy.set(unit, ref)
			}
		}
	}
	// Kit names are rewritten in every unit (see kitReference), so their uses need not stay together.
	const blocked = new Set(
		units.filter((unit) => unit.skips.length > 0).map((unit) => find(unit.index)),
	)
	const left = new Set(units.filter((unit) => blocked.has(find(unit.index))))
	for (const unit of left) {
		if (unit.skips.length > 0 || unit.edits.length === 0) continue
		addSkip(ctx, unit, linkedBy.get(unit) ?? unit.node, 'mixed-reference')
	}
	return left
}

function scanConsumers(ctx, unit) {
	walk(unit.node, (call) => {
		if (call.type !== 'CallExpression' || isRegistrationCallee(ctx, call.callee)) return
		const { root } = chainOf(unwrap(call.callee))
		if (
			root.type === 'Identifier' &&
			/^(?:expect|assert|describe|it|test|vi|jest|console)$/.test(root.name)
		)
			return
		if (
			root.type === 'Identifier' &&
			JS_GLOBALS.has(root.name) &&
			!resolveBinding(root, ctx.parents)
		)
			return
		const origin = consumerOrigin(ctx, call.callee)
		if (!origin) return
		for (const argument of call.arguments) {
			if (isFunctionDefinition(argument, call)) continue
			const { local, imported, callback } = consumedSchemas(ctx, argument)
			if (callback) addManual(ctx, unit, argument, 'zod-consumer-unproven')
			if (origin === 'unproven') {
				if (local) {
					unit.contexts.push(argument)
					addSkip(ctx, unit, argument, 'zod-consumer-unproven')
				}
				if (imported) addManual(ctx, unit, argument, 'zod-consumer-unproven')
				continue
			}
			if (local) {
				unit.contexts.push(argument)
				addSkip(ctx, unit, argument, 'zod-consumer')
			}
			if (imported) addManual(ctx, unit, argument, 'zod-consumer-import')
		}
	})
}

/** Inspect values crossing the call boundary, without treating callback bodies as arguments. */
function consumedSchemas(ctx, expression, seen = new Set()) {
	const result = { local: false, imported: false, callback: false }
	const merge = (value) => {
		const found = consumedSchemas(ctx, value, nextSeen)
		for (const key of Object.keys(result)) result[key] ||= found[key]
	}
	const node = unwrap(expression)
	if (!node || seen.has(node)) return result
	const nextSeen = new Set(seen).add(node)
	if (['ArrowFunctionExpression', 'FunctionExpression'].includes(node.type)) {
		const returned = []
		if (node.body.type !== 'BlockStatement') returned.push(node.body)
		else
			walk(node.body, (item) => {
				if (item.type !== 'ReturnStatement' || !item.argument) return
				let owner = ctx.parents.get(item)
				while (
					owner &&
					!['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(
						owner.type,
					)
				)
					owner = ctx.parents.get(owner)
				if (owner === node) returned.push(item.argument)
			})
		result.callback = returned.some((value) => {
			const found = consumedSchemas(ctx, value, nextSeen)
			return found.local || found.imported
		})
		return result
	}
	if (node.type === 'ObjectExpression') {
		for (const property of node.properties) {
			if (property.type === 'SpreadElement') merge(property.argument)
			else if (property.type === 'Property' && property.kind === 'init') merge(property.value)
		}
		return result
	}
	if (node.type === 'ArrayExpression') {
		for (const element of node.elements)
			merge(element?.type === 'SpreadElement' ? element.argument : element)
		return result
	}
	const { root, steps } = chainOf(node)
	if (root.type !== 'Identifier') return result
	const binding = resolveBinding(root, ctx.parents)
	const namespace = binding?.kind === 'import' && ctx.zodNamespaces.has(root.name)
	let index = namespace ? 2 : 0
	if (namespace && (steps[0]?.kind !== 'member' || steps[1]?.kind !== 'call')) return result
	for (; index < steps.length; index++) {
		const step = steps[index]
		if (step.kind !== 'member') return result
		if (step.name === 'shape') {
			if (!steps[index + 1]) return result
			if (steps[index + 1]?.kind === 'member') index++
			continue
		}
		if (
			!SCHEMA_METHODS.has(step.name) ||
			/^(?:parse|safeParse)(?:Async)?$/.test(step.name) ||
			steps[index + 1]?.kind !== 'call'
		)
			return result
		index++
	}
	result.local = namespace
	if (binding?.kind === 'const' && binding.path?.length === 0 && binding.init) merge(binding.init)
	result.imported ||=
		binding?.kind === 'import' &&
		Boolean(ctx.options.run?.isK(ctx.path, binding.source, binding.imported))
	if (result.local || result.imported)
		for (const step of steps)
			if (step.kind === 'call') for (const argument of step.node.arguments) merge(argument)
	return result
}

/** A file marker only counts actual held Zod declarations, rather than type-only uses. */
function keptByMarker(path, source, program, options) {
	const ctx = createContext(path, source, program, options)
	collectImports(ctx)
	const units = program.body.filter((node) => node.type !== 'ImportDeclaration').map(createUnit)
	classifyBindings(ctx, units)
	for (const unit of units) scanUnit(ctx, unit)
	const held = units.filter((unit) => counted(unit) && unit.zodRefs > 0)
	for (const unit of units) checkHeldPipes(ctx, unit)
	return result(path, source, held.length > 0 ? 'kept' : 'untouched', {
		declarations: { rewritten: 0, left: held.length },
		skipped: [
			...held.map((unit) => ({ ...siteAt(ctx, unit.node), code: 'keep-zod-marker' })),
			...units.flatMap((unit) => unit.manual),
		],
	})
}

/** Imported values in schema positions must be proved by the run before becoming k fields. */
function scanForeignSchemas(ctx, unit) {
	if (ctx.options.deferForeign) return
	const foreign = (expression) => {
		const node = unwrap(expression)
		if (!node) return false
		const { root } = chainOf(node)
		if (root.type !== 'Identifier') return false
		const binding = resolveBinding(root, ctx.parents)
		return (
			binding?.kind === 'import' &&
			!/^(?:zod|cvx-kit|convex)(?:[-/]|$)/.test(binding.source) &&
			!isSchemaExpression(ctx, node)
		)
	}
	walk(unit.node, (node, parent) => {
		if (
			node.type === 'Property' &&
			!node.computed &&
			['args', 'returns'].includes(node.key.name ?? node.key.value) &&
			isFunctionDefinition(parent, ctx.parents.get(parent)) &&
			foreign(node.value)
		) {
			unit.zodValue = true
			addSkip(ctx, unit, node.value, 'zod-foreign-schema')
		}
		if (node.type !== 'CallExpression') return
		const { root, steps } = chainOf(node.callee)
		if (
			root.type !== 'Identifier' ||
			!ctx.zodNamespaces.has(root.name) ||
			!['object', 'strictObject', 'looseObject'].includes(steps[0]?.name)
		)
			return
		const fields = unwrap(node.arguments[0])
		if (fields?.type !== 'ObjectExpression') return
		for (const property of fields.properties)
			if (property.type === 'Property' && foreign(property.value))
				addSkip(ctx, unit, property.value, 'mixed-reference')
	})
}

/** Remove local mask declarations only when every value reference is inside a landed edit. */
function removeUsedMasks(ctx, units, edits) {
	for (const unit of units) {
		if (
			unit.node !== unit.declaration ||
			unit.declaration.type !== 'VariableDeclaration' ||
			unit.declaration.kind !== 'const' ||
			unit.declaration.declarations.length !== 1
		)
			continue
		const declaration = unit.declaration.declarations[0]
		if (
			declaration.id.type !== 'Identifier' ||
			unwrap(declaration.init)?.type !== 'ObjectExpression'
		)
			continue
		const references = []
		walk(ctx.program, (node, parent) => {
			if (
				node.type === 'Identifier' &&
				node.name === declaration.id.name &&
				isReference(node, parent) &&
				resolveBinding(node, ctx.parents)?.init === declaration.init
			)
				references.push(node)
		})
		if (
			references.length > 0 &&
			references.every((node) =>
				edits.some((edit) => edit.start <= node.start && node.end <= edit.end && edit.text !== ''),
			)
		)
			edits.push({ start: unit.node.start, end: unit.node.end, text: '' })
	}
}
