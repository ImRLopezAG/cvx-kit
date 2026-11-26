// Type helpers: `z.infer<T>`, `z.input<T>` and `z.output<T>` become the `k`
// helpers; every other type reached through the Zod binding stays and is reported.
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
	unit.contexts.push(reference)
	addEdit(unit, id, 'k', true)
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
