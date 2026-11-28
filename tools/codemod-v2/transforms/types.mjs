// Type helpers: `z.infer<T>`, `z.input<T>` and `z.output<T>` become the `k`
// helpers when `T` is `typeof x` for a schema known to be `k` after the run: a
// schema or table declared in this file (its unit joins the type's component,
// so both are rewritten or both stay Zod), or a name imported from a file of the
// same run that exports it as `k`. Any other type argument stays Zod and is
// reported, because `k.infer` of a Zod schema is silently `unknown`. Every other
// type reached through the Zod binding stays and is reported.
import { isSchemaExpression } from './schema.mjs'
import { addEdit, addSkip } from './sites.mjs'

const TYPE_HELPERS = new Set(['infer', 'input', 'output'])

/** `id` is the Zod binding on the left of a TSQualifiedName. */
export function processZodType(ctx, unit, id, qualified) {
	const reference = ctx.parents.get(qualified)
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
