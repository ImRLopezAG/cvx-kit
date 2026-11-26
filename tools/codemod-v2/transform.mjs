// One file through the v2 codemod. Every top-level statement is a unit; units
// whose schemas reference each other form a component, and a component with any
// unsupported site stays Zod byte for byte while the rest is rewritten.
import {
	applyEdits,
	isReference,
	lineIndex,
	parentMap,
	parseSource,
	patternNames,
	unwrap,
	walk,
} from './transforms/ast.mjs'
import { collectImports, KIT_RENAMES, planImports, ZOD_INTEROP } from './transforms/imports.mjs'
import { isSchemaExpression, processBoundChain, processZodChain } from './transforms/schema.mjs'
import { getterEdits } from './transforms/getters.mjs'
import { addEdit, addSkip } from './transforms/sites.mjs'
import { isCreateTable, processTableCall, tableKind } from './transforms/tables.mjs'
import { processZodType } from './transforms/types.mjs'

export const KEEP_MARKER = 'cvx-kit-codemod: keep-zod'

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
 */
export function transformSource(path, source, options = {}) {
	let parsed
	try {
		parsed = parseSource(path, source)
	} catch (error) {
		return failure(path, source, error.message)
	}
	if (parsed.errors.length > 0) return failure(path, source, parsed.errors[0].message)
	if (parsed.comments.some((comment) => comment.value.trim() === KEEP_MARKER)) {
		return result(path, source, 'kept')
	}
	try {
		return rewrite(path, source, parsed.program, options.getters !== false)
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
		output,
		...fields,
	}
}

function failure(path, source, message) {
	return result(path, source, 'error', { error: message })
}

function createContext(source, program) {
	return {
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
		schemaBindings: new Set(),
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
		safeResults: new Set(),
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

function rewrite(path, source, program, getters) {
	const ctx = createContext(source, program)
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
	if (ctx.zodNamespaces.size === 0 && ctx.zodNamed.size === 0 && ctx.kit.size === 0) {
		return result(path, source, 'untouched')
	}
	classifyBindings(ctx, units)
	for (const unit of units) scanUnit(ctx, unit)
	if (getters) for (const unit of units) unit.getterEdits = getterEdits(unit.node)
	const left = decideComponents(ctx, units)
	if (ctx.kConflict && units.some((unit) => unit.edits.length > 0)) {
		const skipped = [{ ...siteAt(ctx, ctx.kConflict), code: 'k-conflict' }]
		return result(path, source, 'untouched', { skipped })
	}
	const isLeft = (unit) => left.has(unit)
	const editsOf = (unit) => [...unit.edits, ...unit.getterEdits]
	const applied = units.filter((unit) => !isLeft(unit) && editsOf(unit).length > 0)
	if (applied.length === 0) return summarize(path, source, ctx, units, isLeft, source)
	const needsK = applied.some((unit) => unit.edits.some((edit) => edit.usesK))
	const imports = planImports(ctx, (index) => isLeft(units[index]), needsK)
	const output = applyEdits(source, [...applied.flatMap(editsOf), ...imports.edits])
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
		mixed ? 'mixed' : 'rewritten',
		applied.length,
	)
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

function summarize(path, source, ctx, units, isLeft, output, status = 'untouched', rewritten = 0) {
	const skipped = []
	const info = []
	const declarations = { rewritten: 0, left: 0 }
	for (const unit of units) {
		if (isLeft(unit)) skipped.push(...unit.skips)
		else info.push(...unit.info)
		if (!counted(unit)) continue
		if (isLeft(unit)) declarations.left++
		else declarations.rewritten++
	}
	skipped.sort((left, right) => left.line - right.line || left.column - right.column)
	return result(path, output, output === source ? 'untouched' : status, {
		rewritten,
		skipped,
		info,
		declarations,
	})
}

/** Top-level `const` bindings the codemod can prove are schemas, tables or table factories. */
function classifyBindings(ctx, units) {
	for (let pass = 0; pass < 2; pass++) {
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
				else if (isSchemaExpression(ctx, init)) ctx.schemaBindings.add(name)
			}
		}
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
		if (kind) processTableCall(ctx, unit, call, kind)
	}
	for (const [node, parent] of identifiers) {
		if (!isReference(node, parent)) continue
		const name = node.name
		if (ctx.zodNamespaces.has(name)) zodReference(ctx, unit, node, parent)
		else if (ctx.zodNamed.has(name)) {
			countZodRef(ctx, unit, name)
			addSkip(ctx, unit, node, 'zod-type')
		} else if (ctx.kit.has(name)) kitReference(ctx, unit, node, parent)
		if (ctx.owners.has(name)) unit.refs.push(node)
		const member = parent?.type === 'MemberExpression' && parent.object === node
		if (!member) continue
		if (ctx.schemaBindings.has(name)) processBoundChain(ctx, unit, node, false)
		else if (ctx.tableBindings.has(name)) processBoundChain(ctx, unit, node, true)
	}
	if (unit.safeResults.size === 0) return
	walk(unit.node, (node) => {
		if (node.type !== 'MemberExpression' || node.computed) return
		if (node.object.type !== 'Identifier' || !unit.safeResults.has(node.object.name)) return
		if (node.property.name === 'error') addSkip(ctx, unit, node, 'zod-introspection')
	})
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
	if (renamed && binding.local === binding.imported) addEdit(unit, node, renamed)
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
	for (const binding of ctx.kit.values()) {
		// v1 and v2 forms cannot share one local name: an aliased rename, or a
		// `cvx-kit/zod-table` name that moves to `cvx-kit/table` unchanged.
		const renamed = KIT_RENAMES.has(binding.imported)
		const conflicts = renamed
			? binding.local !== binding.imported
			: binding.module === 'cvx-kit/zod-table'
		if (!conflicts || binding.imported === 'zid' || ZOD_INTEROP.has(binding.imported)) continue
		for (const index of binding.refs.slice(1)) union(binding.refs[0], index)
	}
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
