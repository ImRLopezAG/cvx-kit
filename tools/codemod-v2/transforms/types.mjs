// Type helpers: `z.infer<T>`, `z.input<T>` and `z.output<T>` become the `k`
// helpers when `T` is `typeof x` for a schema known to be `k` after the run: a
// schema or table declared in this file (its unit joins the type's component,
// so both are rewritten or both stay Zod), or a name imported from a file of the
// same run that exports it as `k`. Any other type argument stays Zod and is
// reported, because `k.infer` of a Zod schema is silently `unknown`. Every other
// type reached through the Zod binding stays and is reported.
import { chainOf, isReference, resolveBinding, unwrap, walk } from './ast.mjs'
import { isSchemaExpression } from './schema.mjs'
import { addEdit, addSkip } from './sites.mjs'

const TYPE_HELPERS = new Set(['infer', 'input', 'output'])

/** `id` is the Zod binding on the left of a TSQualifiedName. */
export function processZodType(ctx, unit, id, qualified) {
	const reference = ctx.parents.get(qualified)
	if (ctx.genericConstraints?.has(qualified)) {
		const target = ctx.genericConstraints.get(qualified)
		addEdit(unit, reference, target)
		unit.genericTypes ??= new Set()
		for (const name of target === 'AnyKSchema' ? ['AnyKSchema'] : ['KObject', 'KFields'])
			unit.genericTypes.add(name)
		return
	}

	for (const [constraint] of ctx.genericConstraints ?? []) {
		const range = ctx.parents.get(constraint)
		if (range.start < qualified.start && qualified.end <= range.end) return
	}
	const helper =
		qualified.right.type === 'Identifier' &&
		TYPE_HELPERS.has(qualified.right.name) &&
		reference?.type === 'TSTypeReference' &&
		reference.typeName === qualified
	if (!helper) {
		addSkip(ctx, unit, outermostQualified(ctx, qualified), 'zod-type')
		return
	}
	if (!knownK(ctx, reference)) {
		addSkip(ctx, unit, reference, 'type-helper-unknown')
		return
	}
	unit.contexts.push(reference)
	addEdit(unit, id, 'k', true)
}

/** Whether the helper's type argument is `typeof` a schema that is `k` after the run. */
function knownK(ctx, reference) {
	const argument = reference.typeArguments?.params?.[0]
	if (argument?.type !== 'TSTypeQuery') return false
	const asExpression = (node) =>
		node.type === 'TSQualifiedName'
			? {
					type: 'MemberExpression',
					computed: false,
					object: asExpression(node.left),
					property: node.right,
				}
			: node
	const expression = asExpression(argument.exprName)
	// Synthetic member nodes retain the original identifier's lexical scope.
	return isSchemaExpression(ctx, expression)
}

function outermostQualified(ctx, qualified) {
	let current = qualified
	let parent = ctx.parents.get(current)
	while (parent?.type === 'TSQualifiedName' && parent.left === current) {
		current = parent
		parent = ctx.parents.get(current)
	}
	return current
}

/** A private helper is closed when every reference is a direct call with proven schema arguments. */
export function prepareGenericHelpers(ctx, units) {
	ctx.genericConstraints = new Map()
	ctx.genericHelpers = new Set()
	for (const unit of units) {
		const fn = unit.declaration
		if (unit.node !== fn || fn.type !== 'FunctionDeclaration' || !fn.id) continue
		const constraints = (fn.typeParameters?.params ?? []).filter((param) => {
			const type = param.constraint
			return (
				type?.type === 'TSTypeReference' &&
				type.typeName.type === 'TSQualifiedName' &&
				ctx.zodNamespaces.has(type.typeName.left.name) &&
				((['ZodType', 'ZodTypeAny'].includes(type.typeName.right.name) && !type.typeArguments) ||
					(type.typeName.right.name === 'ZodObject' &&
						(!type.typeArguments ||
							(type.typeArguments.params.length === 1 &&
								type.typeArguments.params[0].typeName?.left?.name === type.typeName.left.name &&
								type.typeArguments.params[0].typeName?.right?.name === 'ZodRawShape'))))
			)
		})
		if (constraints.length === 0) continue
		const required = constraints.flatMap((param) =>
			param.constraint.typeName.right.name === 'ZodObject'
				? ['KObject', 'KFields']
				: ['AnyKSchema'],
		)
		if (
			required.some(
				(name) =>
					ctx.owners.has(name) ||
					(ctx.imported.has(name) &&
						!(
							ctx.imported.get(name).source === 'cvx-kit/k' &&
							ctx.imported.get(name).imported === name
						)),
			)
		)
			continue
		const positions = constraints.map((param) =>
			fn.params.findIndex(
				(argument) => argument.typeAnnotation?.typeAnnotation?.typeName?.name === param.name.name,
			),
		)
		if (positions.some((index) => index < 0)) continue
		if (!genericMembersMap(ctx, fn, constraints)) continue
		let calls = 0
		let safe = true
		walk(ctx.program, (node, parent) => {
			if (
				node.type !== 'Identifier' ||
				node.name !== fn.id.name ||
				!(
					isReference(node, parent) ||
					(parent?.type === 'ExportSpecifier' && parent.local === node)
				)
			)
				return
			if (parent?.type !== 'CallExpression' || parent.callee !== node) {
				safe = false
				return
			}
			calls++
			for (const position of positions) {
				const value = parent.arguments[position]
				if (!isSchemaExpression(ctx, value)) {
					safe = false
					continue
				}
				const binding = resolveBinding(value, ctx.parents)
				if (
					binding?.kind === 'import' &&
					!ctx.options.run?.isK(ctx.path, binding.source, binding.imported)
				)
					safe = false
			}
		})
		if (!safe || calls === 0) continue
		ctx.genericHelpers.add(fn.id.name)
		for (const param of constraints)
			ctx.genericConstraints.set(
				param.constraint.typeName,
				param.constraint.typeName.right.name === 'ZodObject' ? 'KObject<KFields>' : 'AnyKSchema',
			)
	}
}

/** Generic values only use members whose spelling and arguments already map directly. */
function genericMembersMap(ctx, fn, constraints) {
	const names = new Set(constraints.map((param) => param.name.name))
	const members = new Set(['parse', 'optional', 'nullable', 'unwrap', 'shape', 'element'])
	let safe = true
	walk(fn.body, (node) => {
		if (node.type !== 'MemberExpression') return
		const { root } = chainOf(node)
		if (root.type !== 'Identifier') return
		if (!genericValue(ctx, root, names)) return
		if (node.computed || !members.has(node.property.name)) safe = false
	})
	return safe
}

function genericValue(ctx, expression, names, seen = new Set()) {
	const node = unwrap(expression)
	if (!node || seen.has(node)) return false
	const { root } = chainOf(node)
	if (root.type !== 'Identifier') return false
	const binding = resolveBinding(root, ctx.parents)
	const declaration = binding?.node
	const annotation = (declaration?.id ?? declaration)?.typeAnnotation?.typeAnnotation
	if (annotation?.type === 'TSTypeReference' && names.has(annotation.typeName?.name)) return true
	return Boolean(binding?.init && genericValue(ctx, binding.init, names, new Set(seen).add(node)))
}
