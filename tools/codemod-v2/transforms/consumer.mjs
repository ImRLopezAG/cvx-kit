// Follow builder values by lexical binding, retaining member paths across local objects.
import { chainOf, resolveBinding, unwrap } from './ast.mjs'
import { KIT_OR_ZOD_MODULE } from '../resolve.mjs'

export function consumerOrigin(ctx, expression, path = [], seen = new Set()) {
	const node = unwrap(expression)
	if (!node || seen.has(node)) return 'unproven'
	seen.add(node)
	if (node.type === 'MemberExpression') {
		const key = node.computed ? node.property.value : node.property.name
		if (key === undefined) return 'unproven'
		return consumerOrigin(ctx, node.object, [key, ...path], seen)
	}
	if (node.type === 'CallExpression') return consumerOrigin(ctx, node.callee, [], seen)
	if (node.type === 'NewExpression') return consumerOrigin(ctx, node.callee, path, seen)
	if (node.type === 'ObjectExpression') {
		const property = node.properties.find(
			(item) =>
				item.type === 'Property' && !item.computed && (item.key.name ?? item.key.value) === path[0],
		)
		return property ? consumerOrigin(ctx, property.value, path.slice(1), seen) : 'unproven'
	}
	if (node.type === 'ThisExpression') {
		for (let scope = ctx.parents.get(node); scope; scope = ctx.parents.get(scope)) {
			if (scope.type === 'ClassBody') return fieldOrigin(ctx, scope, path, seen)
		}
		return 'unproven'
	}
	if (node.type !== 'Identifier') {
		return ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(
			node.type,
		)
			? false
			: 'unproven'
	}
	const binding = resolveBinding(node, ctx.parents)
	if (!binding) return 'unproven'
	if (binding.kind === 'parameter') return path.length > 0 ? 'unproven' : false
	if (binding.kind === 'function') return false
	if (binding.kind === 'class') return fieldOrigin(ctx, binding.node.body, path, seen)
	if (binding.kind === 'import') {
		if (ctx.options.run?.consumerOrigin) {
			const imported = binding.imported === '*' && path.length ? path[0] : binding.imported
			return ctx.options.run.consumerOrigin(
				ctx.path,
				binding.source,
				imported,
				binding.imported === '*' ? path.slice(1) : path,
			)
		}
		return !binding.source.startsWith('.') && !binding.source.startsWith('/')
			? !KIT_OR_ZOD_MODULE.test(binding.source)
			: 'unproven'
	}
	if (binding.kind !== 'const' || !binding.init || binding.path === null) return 'unproven'
	return consumerOrigin(ctx, binding.init, [...binding.path, ...path], seen)
}

function fieldOrigin(ctx, body, path, seen) {
	const field = body.body.find(
		(item) =>
			item.type === 'PropertyDefinition' &&
			!item.computed &&
			(item.key.name ?? item.key.value) === path[0],
	)
	return field?.value ? consumerOrigin(ctx, field.value, path.slice(1), seen) : 'unproven'
}

export function isRegistrationCallee(ctx, callee, seen = new Set()) {
	const { root, steps } = chainOf(unwrap(callee))
	if (root.type !== 'Identifier' || seen.has(root)) return false
	seen.add(root)
	const binding = resolveBinding(root, ctx.parents)
	if (binding?.kind === 'const' && binding.init && binding.path?.length === 0)
		return (
			!steps.some((step) => step.kind === 'member') && isRegistrationCallee(ctx, binding.init, seen)
		)
	if (binding?.kind !== 'import') return false
	const members = steps.filter((step) => step.kind === 'member')
	if (members.length !== (binding.imported === '*' ? 1 : 0)) return false
	const name = binding.imported === '*' ? members[0]?.name : binding.imported
	if (/^cvx-kit(?:\/(?:registration|contracts))?$/.test(binding.source))
		return /^(?:kContract|zodContract|standardContract|[kz]Custom(?:Query|Mutation|Action))$/.test(
			name,
		)
	if (
		/^(?:convex\/server|convex-helpers\/server\/zod4?)$/.test(binding.source) ||
		/\/_generated\/server(?:\.[cm]?[jt]s)?$/.test(binding.source)
	)
		return /^(?:(?:internal)?(?:query|mutation|action)|(?:query|mutation|action)Generic|[kz]Custom(?:Query|Mutation|Action))$/i.test(
			name,
		)
	return false
}
