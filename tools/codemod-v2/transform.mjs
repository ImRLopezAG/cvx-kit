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
	processBoundChain,
	processZodChain,
} from './transforms/schema.mjs'
import { KIT_OR_ZOD_MODULE } from './resolve.mjs'
import { getterEdits } from './transforms/getters.mjs'
import { addEdit, addInfo, addManual, addSkip } from './transforms/sites.mjs'
import { isCreateTable, processTableCall, tableKind } from './transforms/tables.mjs'
import { processZodType } from './transforms/types.mjs'

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
		refinedBindings: new Set(),
		numberBindings: new Set(),
		integerBindings: new Set(),
		tableBindings: new Set(),
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
		walk(unit.node, (node) => {
			if (
				node.type !== 'CallExpression' ||
				node.callee.type !== 'MemberExpression' ||
				node.callee.property.name !== 'pipe'
			)
				return
			const arg = node.arguments[0]
			if (arg?.type !== 'Identifier') return
			const binding = ctx.imported.get(arg.name)
			if (binding && ctx.options.run?.isK(ctx.path, binding.source, binding.imported))
				addManual(ctx, unit, node, 'held-pipe-to-k')
		})
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
	const edits = [...units.flatMap(editsOf), ...imports.edits]
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
	const tableExports = [...exports]
		.filter(([, local]) => kLocals.has(local) && ctx.tableBindings.has(local))
		.map(([name]) => name)
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
	const skipped = []
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
	const remainingZod = units.some((unit) => isLeft(unit) && counted(unit))
	const noChangeStatus = remainingZod
		? ctx.hasK || ctx.v2Tables.size > 0
			? 'mixed'
			: 'kept'
		: 'untouched'
	return result(path, output, output === source ? noChangeStatus : status, {
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
		ctx.tableBindings,
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
			if (unit.declaration.type !== 'VariableDeclaration') continue
			for (const declarator of unit.declaration.declarations) {
				if (declarator.id.type !== 'Identifier' || !declarator.init) continue
				const name = declarator.id.name
				const init = unwrap(declarator.init)
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

function scanUnit(ctx, unit) {
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
		const kind = tableKind(ctx, call)
		if (kind) processTableCall(ctx, unit, call)
	}
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
		else if (
			ctx.schemaBindings.has(name) ||
			(external && ctx.options.run?.isK(ctx.path, imported.source, imported.imported))
		)
			processBoundChain(ctx, unit, node, false)
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
	const { root } = chainOf(callee.object)
	if (root.type === 'Identifier') {
		if (ctx.zodNamespaces.has(root.name)) return
		if (ctx.schemaBindings.has(root.name) || ctx.tableBindings.has(root.name)) return
		const imported = ctx.imported.get(root.name)
		if (
			imported &&
			(ctx.options.run?.isTable(ctx.path, imported.source, imported.imported) ||
				ctx.options.run?.isK(ctx.path, imported.source, imported.imported))
		)
			return
		if (root.name === 'k' && ctx.hasK) return
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
				ctx.schemaBindings.has(name) || ctx.tableBindings.has(name) || ctx.tableFactories.has(name),
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

/** Root a builder chain through local const initializers and source imports. */
function consumerOrigin(ctx, expression, seen = new Set()) {
	const { root } = chainOf(unwrap(expression))
	if (root.type !== 'Identifier' || seen.has(root)) return false
	seen.add(root)
	for (let scope = ctx.parents.get(root); scope; scope = ctx.parents.get(scope)) {
		if (scope.type !== 'BlockStatement' && scope.type !== 'Program') continue
		for (const statement of scope.body) {
			const declaration = statement.declaration ?? statement
			if (declaration.type !== 'VariableDeclaration') continue
			const local = declaration.declarations.find(
				(item) => item.id.type === 'Identifier' && item.id.name === root.name,
			)
			if (local)
				return declaration.kind === 'const' && local.init
					? consumerOrigin(ctx, local.init, seen)
					: false
		}
	}
	if (isShadowed(root, root.name, ctx.parents)) return false
	const binding = ctx.imported.get(root.name)
	if (!binding) return false
	if (ctx.options.run?.consumerOrigin)
		return ctx.options.run.consumerOrigin(ctx.path, binding.source, binding.imported)
	return (
		!binding.source.startsWith('.') &&
		!binding.source.startsWith('/') &&
		!KIT_OR_ZOD_MODULE.test(binding.source)
	)
}

function scanConsumers(ctx, unit) {
	walk(unit.node, (call) => {
		if (call.type !== 'CallExpression') return
		const origin = consumerOrigin(ctx, call.callee)
		if (!origin) return
		for (const argument of call.arguments) {
			let local = false
			let imported = false
			walk(argument, (node, parent) => {
				if (
					node.type !== 'Identifier' ||
					!isReference(node, parent) ||
					isShadowed(node, node.name, ctx.parents)
				)
					return
				if (ctx.zodNamespaces.has(node.name) || ctx.schemaBindings.has(node.name)) local = true
				const binding = ctx.imported.get(node.name)
				if (binding && ctx.options.run?.isK(ctx.path, binding.source, binding.imported))
					imported = true
			})
			if (origin === 'unproven') {
				if (local || imported) addManual(ctx, unit, argument, 'zod-consumer-unproven')
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

/** A file marker only counts actual held Zod declarations, rather than type-only uses. */
function keptByMarker(path, source, program, options) {
	const ctx = createContext(path, source, program, options)
	collectImports(ctx)
	const units = program.body.filter((node) => node.type !== 'ImportDeclaration').map(createUnit)
	classifyBindings(ctx, units)
	for (const unit of units) scanUnit(ctx, unit)
	const held = units.filter((unit) => counted(unit) && unit.zodRefs > 0)
	return result(path, source, held.length > 0 ? 'kept' : 'untouched', {
		declarations: { rewritten: 0, left: held.length },
		skipped: held.map((unit) => ({ ...siteAt(ctx, unit.node), code: 'keep-zod-marker' })),
	})
}
