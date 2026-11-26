// Neutral, JSON-serialisable description of a set of named validator schemas.
// The emitters turn one descriptor into equivalent modules for every flavor.
//
// {
//   schemas: [{ name: 'user', node: { kind: 'object', fields: { email: { kind: 'string', trim: true, min: 3 } } } }],
//   groups: [{ name: 'users', table: 'user', args: 'userArgs' }],
// }
//
// Nodes carry their kind, kind-specific parts (value, values, table, element,
// fields, members, name), checks (string: min, max, regex, trim; number/int:
// min, max; array: min, max) and modifiers (optional, nullable, default).

export const kinds = {
	string: ['min', 'max', 'regex', 'trim'],
	number: ['min', 'max'],
	int: ['min', 'max'],
	boolean: [],
	null: [],
	literal: ['value'],
	enum: ['values'],
	id: ['table'],
	array: ['element', 'min', 'max'],
	object: ['fields'],
	union: ['members'],
	ref: ['name'],
}

const modifiers = ['optional', 'nullable', 'default']
const identifier = /^[A-Za-z_$][\w$]*$/
// Names the emitted modules declare themselves.
const reserved = new Set([
	'z',
	'v',
	'k',
	'zid',
	'zodToConvex',
	'defineTable',
	'queryGeneric',
	'forceNative',
])

/** Throws on the first malformed part of `descriptor`, naming it. Returns the descriptor. */
export function validate(descriptor) {
	if (!Array.isArray(descriptor?.schemas)) throw new Error('Descriptor needs a `schemas` array')
	const declared = new Map()
	for (const [index, schema] of descriptor.schemas.entries()) {
		const name = schema?.name
		if (!identifier.test(name ?? '') || reserved.has(name))
			throw new Error(`Invalid schema name ${JSON.stringify(name)} at schemas[${index}]`)
		if (declared.has(name)) throw new Error(`Duplicate schema name ${name}`)
		if (schema.node?.optional || schema.node?.default !== undefined)
			throw new Error(`Top-level schema ${name} cannot be optional or have a default`)
		checkNode(schema.node, name, declared, false)
		declared.set(name, schema.node)
	}
	for (const [index, group] of (descriptor.groups ?? []).entries()) {
		for (const role of ['table', 'args']) {
			const node = declared.get(group?.[role])
			if (node?.kind !== 'object')
				throw new Error(
					`Group ${group?.name ?? index} ${role} must name an object schema, got ${JSON.stringify(group?.[role])}`,
				)
		}
	}
	return descriptor
}

function checkNode(node, at, declared, isField) {
	const kind = node?.kind
	if (!Object.hasOwn(kinds, kind))
		throw new Error(`Unknown descriptor kind ${JSON.stringify(kind)} at ${at}`)
	const allowed = new Set(['kind', ...kinds[kind], ...modifiers])
	for (const key of Object.keys(node)) {
		if (!allowed.has(key))
			throw new Error(`Unknown check ${JSON.stringify(key)} on ${kind} at ${at}`)
	}
	if (!isField && (node.optional || node.default !== undefined))
		throw new Error(`Only object fields can be optional or have a default (${at})`)
	if (kind === 'enum' && !(Array.isArray(node.values) && node.values.length > 0))
		throw new Error(`enum needs string values at ${at}`)
	if (kind === 'literal' && !['string', 'number', 'boolean'].includes(primitive(node.value)))
		throw new Error(`literal needs a string, number or boolean value at ${at}`)
	if (kind === 'id' && !node.table) throw new Error(`id needs a table at ${at}`)
	if (kind === 'ref' && !declared.has(node.name))
		throw new Error(`ref ${JSON.stringify(node.name)} at ${at} does not name an earlier schema`)
	if (kind === 'array') checkNode(node.element, `${at}[]`, declared, false)
	if (kind === 'union') {
		if (!(Array.isArray(node.members) && node.members.length > 0))
			throw new Error(`union needs members at ${at}`)
		for (const [index, member] of node.members.entries())
			checkNode(member, `${at}|${index}`, declared, false)
	}
	if (kind === 'object') {
		for (const [field, child] of Object.entries(node.fields ?? {})) {
			if (!identifier.test(field)) throw new Error(`Invalid field name ${field} at ${at}`)
			checkNode(child, `${at}.${field}`, declared, true)
		}
	}
}

function primitive(value) {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Literal values arrive from JSON and are checked by type.
	return typeof value
}
