import type { KFields, KLiteralValue, KNode, KType } from './types'

/**
 * The dispatch map of a discriminated union: each discriminator value to the option that declares it.
 * Built once, at declaration, from the option field maps only (no validator is built), so an
 * unsupported discriminator or a duplicate value fails where the schema is written. A discriminator
 * may be a literal, an enum, or a union of literals and enums (natively the same union as an enum).
 */
export function discriminatorDispatch(
	key: string,
	options: readonly KType[],
): ReadonlyMap<KLiteralValue, KNode> {
	const dispatch = new Map<KLiteralValue, KNode>()
	for (let index = 0; index < options.length; index++) {
		const option: KNode = options[index]
		const root = rootOf(option)
		if (root.op !== 'object')
			throw new Error(
				`k.discriminatedUnion('${key}'): option ${index} must be a k.object, got '${root.op}'`,
			)
		// SAFETY: k.object stores its field map as the root argument.
		const field = (root.arg as KFields)[key]
		if (field === undefined)
			throw new Error(`k.discriminatedUnion('${key}'): option ${index} has no '${key}' field`)
		for (const value of discriminatorValues(field, key, index)) {
			if (dispatch.has(value))
				throw new Error(
					`k.discriminatedUnion('${key}'): more than one option has '${key}' value ${JSON.stringify(String(value))} (option ${index} repeats it)`,
				)
			dispatch.set(value, option)
		}
	}
	return dispatch
}

function discriminatorValues(field: KNode, key: string, index: number): readonly KLiteralValue[] {
	const root = rootOf(field)
	switch (root.op) {
		case 'literal':
			// SAFETY: k.literal stores its literal value as the root argument.
			return [root.arg as KLiteralValue]
		case 'enum':
			// SAFETY: k.enum stores its value list as the root argument.
			return root.arg as readonly string[]
		case 'union':
			// SAFETY: k.union stores its member schemas as the root argument.
			return (root.arg as readonly KNode[]).flatMap((member) =>
				discriminatorValues(member, key, index),
			)
		default:
			throw new Error(
				`k.discriminatedUnion('${key}'): '${key}' must be a literal, an enum or a union of literals on every option; option ${index} has '${root.op}'`,
			)
	}
}

function rootOf(node: KNode): KNode {
	let root = node
	while (root.prev !== null) root = root.prev
	return root
}
