// Kit table boundaries: `zodTable('t', (id) => ({ … }), opts)` becomes
// `kTable('t', { … }, opts)` with `id(…)` → `k.id(…)`, for every table form
// whose callback has that same shape.
import { chainOf, isReference, isShadowed, resolveBinding, unwrap, walk } from './ast.mjs'
import { isSchemaExpression } from './schema.mjs'
import { addEdit, addSkip } from './sites.mjs'

const TABLE_FUNCTIONS = new Set(['zodTable', 'zodVariantTable', 'tenantTable'])

/** The kit function a call defines a table with, or null. */
export function tableKind(ctx, call) {
	const callee = call.callee
	if (callee.type === 'Identifier') {
		const imported = ctx.kit.get(callee.name)?.imported
		if (TABLE_FUNCTIONS.has(imported)) return imported
		if (ctx.tableFactories.has(callee.name)) return 'createTable'
		if (ctx.v2Tables.has(callee.name)) return 'kTable'
	}
	if (callee.type === 'CallExpression' && isCreateTable(ctx, callee)) return 'createTable'
	return null
}

export function isCreateTable(ctx, call) {
	return (
		call.callee.type === 'Identifier' && ctx.kit.get(call.callee.name)?.imported === 'createTable'
	)
}

export function processTableCall(ctx, unit, call) {
	const kind = tableKind(ctx, call)
	const types = call.typeArguments?.params ?? []
	if (kind === 'zodVariantTable' || kind === 'kVariantTable') {
		if (types.length > 0) addSkip(ctx, unit, call.typeArguments, 'table-type-arguments')
	} else
		for (const type of types.slice(2, 5)) {
			if (type.type === 'TSTypeQuery') {
				if (keyArrayQuery(ctx, type.exprName))
					addEdit(unit, type, `(${ctx.source.slice(type.start, type.end)})[number]`)
				else addSkip(ctx, unit, type, 'table-type-arguments')
			} else if (type.type === 'TSTupleType' || type.type === 'TSArrayType')
				addSkip(ctx, unit, type, 'table-type-arguments')
		}
	unit.tableCall = true
	unit.contexts.push(call)
	const fields = call.arguments[1]
	if (!fields || !isFunction(fields)) return
	if (
		call.arguments.slice(2).every(sideEffectFree) &&
		fields.type === 'ArrowFunctionExpression' &&
		convertCallback(ctx, unit, fields)
	)
		return
	addSkip(ctx, unit, fields, 'table-callback-complex')
}

function isFunction(node) {
	return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression'
}

function convertCallback(ctx, unit, arrow) {
	if (arrow.async || arrow.params.length > 1) return false
	const param = arrow.params[0]
	if (param && param.type !== 'Identifier') return false
	const body = arrow.body.type === 'ParenthesizedExpression' ? arrow.body.expression : arrow.body
	if (body.type === 'Identifier' && ctx.objectConsts.has(body.name) && body.name !== param?.name) {
		// `() => fields` returns a module-level object of validators: pass it directly.
		addEdit(unit, { start: arrow.start, end: body.start }, '')
		addEdit(unit, { start: body.end, end: arrow.end }, '')
		return true
	}
	const block = body.type === 'BlockStatement' && body.body.length > 1
	if (
		block &&
		!body.body
			.slice(0, -1)
			.every(
				(statement) =>
					statement.type === 'VariableDeclaration' &&
					statement.kind === 'const' &&
					statement.declarations.every(
						(declaration) => declaration.id.type === 'Identifier' && declaration.init,
					),
			)
	)
		return false
	const last = block ? body.body.at(-1) : null
	const fields =
		block && last?.type === 'ReturnStatement' ? unwrap(last.argument) : callbackObject(arrow.body)
	if (!fields) return false
	const calls = []
	let complex = false
	if (param) {
		walk(
			body,
			(node, parent) => {
				if (node.type !== 'Identifier' || node.name !== param.name) return
				if (!isReference(node, parent ?? arrow)) return
				if (resolveBinding(node, ctx.parents)?.node !== param) return
				if (
					parent?.type === 'CallExpression' &&
					parent.callee === node &&
					parent.arguments.length === 1 &&
					parent.arguments[0].type === 'Literal' &&
					parent.arguments[0].value === String(parent.arguments[0].value)
				)
					calls.push(node)
				else complex = true
			},
			arrow,
		)
	}
	if (complex) return false
	if (
		isShadowed(fields, 'k', ctx.parents) ||
		calls.some((node) => isShadowed(node, 'k', ctx.parents))
	) {
		addSkip(ctx, unit, arrow, 'k-shadowed')
		return true
	}
	if (block && !fieldObject(ctx, fields, param)) return false
	if (block) {
		addEdit(unit, { start: arrow.start, end: body.start }, '(() => ')
		addEdit(unit, { start: body.end, end: arrow.end }, ')()')
	} else {
		addEdit(unit, { start: arrow.start, end: fields.start }, '')
		addEdit(unit, { start: fields.end, end: arrow.end }, '')
	}
	for (const node of calls) addEdit(unit, node, 'k.id', true)
	return true
}

function fieldObject(ctx, expression, param, seen = new Set()) {
	const node = unwrap(expression)
	if (!node || seen.has(node)) return false
	seen = new Set(seen).add(node)
	if (node.type === 'Identifier') {
		const binding = resolveBinding(node, ctx.parents)
		return (
			binding?.kind === 'const' &&
			binding.path?.length === 0 &&
			fieldObject(ctx, binding.init, param, seen)
		)
	}
	return (
		node.type === 'ObjectExpression' &&
		node.properties.every(
			(property) =>
				property.type === 'Property' &&
				property.kind === 'init' &&
				!property.computed &&
				schemaValue(ctx, property.value, param, seen),
		)
	)
}

function schemaValue(ctx, expression, param, seen = new Set()) {
	const node = unwrap(expression)
	if (!node || seen.has(node)) return false
	const { root, steps } = chainOf(node)
	if (root.type === 'Identifier' && param && resolveBinding(root, ctx.parents)?.node === param)
		return steps[0]?.kind === 'call'
	if (isSchemaExpression(ctx, node)) return true
	if (node.type === 'Identifier') {
		const binding = resolveBinding(node, ctx.parents)
		if (binding?.kind === 'const' && binding.path?.length === 0)
			return schemaValue(ctx, binding.init, param, new Set(seen).add(node))
	}
	return false
}

function callbackObject(body) {
	if (body.type === 'BlockStatement') {
		const only = body.body.length === 1 ? body.body[0] : null
		if (only?.type !== 'ReturnStatement' || !only.argument) return null
		return objectOf(only.argument)
	}
	return objectOf(body)
}

function objectOf(node) {
	let inner = node
	while (inner.type === 'ParenthesizedExpression') inner = inner.expression
	return inner.type === 'ObjectExpression' ? inner : null
}

function keyArrayQuery(ctx, expression) {
	const members = []
	let root = expression
	while (root.type === 'TSQualifiedName') {
		members.unshift(root.right.name)
		root = root.left
	}
	const binding = resolveBinding(root, ctx.parents)
	if (binding?.kind !== 'const' || binding.path?.length !== 0) return false
	let value = unwrap(binding.init)
	for (const member of members) {
		if (value?.type !== 'ObjectExpression') return false
		value = unwrap(
			value.properties.find(
				(property) =>
					property.type === 'Property' &&
					!property.computed &&
					(property.key.name ?? property.key.value) === member,
			)?.value,
		)
	}
	return (
		value?.type === 'ArrayExpression' &&
		value.elements.every((item) => item?.type === 'Literal' && item.value === String(item.value))
	)
}

/** Moving the field callback before later arguments must not move past an effect. */
function sideEffectFree(expression) {
	const node = unwrap(expression)
	if (!node) return false
	// Spreading a plain reference copies it; only a custom iterator or getter could observe the order.
	if (node.type === 'SpreadElement') return sideEffectFree(node.argument)
	if (
		['Identifier', 'Literal', 'ArrowFunctionExpression', 'FunctionExpression'].includes(node.type)
	)
		return true
	if (node.type === 'MemberExpression')
		return (
			!node.computed &&
			sideEffectFree(node.object) &&
			['Identifier', 'MemberExpression'].includes(node.object.type)
		)
	if (node.type === 'ObjectExpression')
		return node.properties.every((property) =>
			property.type === 'SpreadElement'
				? sideEffectFree(property.argument)
				: property.type === 'Property' &&
					!property.computed &&
					property.kind === 'init' &&
					sideEffectFree(property.value),
		)
	if (node.type === 'ArrayExpression') return node.elements.every(sideEffectFree)
	return false
}
