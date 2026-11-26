// Seeded synthetic descriptor whose factory and chain mix follows the call-site
// counts of the Convex code in the two consumer apps:
//   factories: string 6201, object+strictObject 3241, number 1411, enum 1297,
//     array 1268, literal 785, boolean 760, union 308, null 307, int 216
//   chains: optional ~3640, min ~1090, max ~760, nullable ~450, int ~350,
//     trim ~225, regex ~246, default ~131
// Ids are not in those counts; fields named `<table>Id` use them at a small rate.
import { validate } from './descriptor.mjs'

// Field kinds. `object` here is a nested object; top-level schemas make up
// the rest of the object count. `ref` reuses an earlier schema the way apps
// reuse `table.schema.shape.x`.
const fieldWeights = {
	string: 6201,
	number: 1411 - 350,
	int: 216 + 350,
	enum: 1297,
	array: 1500,
	literal: 600,
	boolean: 900,
	union: 308,
	null: 180,
	object: 1800,
	id: 600,
	ref: 300,
}
const elementWeights = { string: 40, object: 30, id: 15, enum: 8, union: 4, number: 3 }
const memberWeights = { literal: 30, object: 25, string: 15, null: 12, number: 8 }
// Per-node chain rates derived from the counts above.
const rates = {
	optional: 3640 / 11500,
	nullable: 450 / 12500,
	default: 131 / 5000,
	min: 1090 / 8880,
	max: 760 / 8880,
	trim: 225 / 6201,
	regex: 246 / 6201,
}
const regexes = [
	'^[a-z0-9-]+$',
	'^\\+?[0-9 ]{7,15}$',
	'^[A-Z]{3}$',
	'^https?://',
	'^\\d{4}-\\d{2}-\\d{2}$',
]
const words = [
	'status',
	'name',
	'title',
	'amount',
	'kind',
	'note',
	'code',
	'label',
	'owner',
	'total',
]
const tables = ['users', 'orgs', 'accounts', 'invoices', 'payments', 'projects', 'tasks', 'files']

/** Returns a validated descriptor with `schemas` top-level schemas from `seed`. */
export function synthetic({ schemas = 400, seed = 1 } = {}) {
	if (!Number.isSafeInteger(schemas) || schemas < 1) throw new Error('Invalid schema count')
	const random = mulberry32(seed)
	const pick = (list) => list[Math.floor(random() * list.length)]
	const chance = (p) => random() < p
	const weighted = (weights) => {
		const entries = Object.entries(weights)
		let roll = random() * entries.reduce((sum, [, weight]) => sum + weight, 0)
		for (const [key, weight] of entries) {
			roll -= weight
			if (roll < 0) return key
		}
		return entries.at(-1)[0]
	}
	const out = { schemas: [], groups: [] }
	const names = []

	const checks = (node) => {
		if (node.kind === 'string') {
			if (chance(rates.trim)) node.trim = true
			if (chance(rates.regex)) node.regex = pick(regexes)
		}
		if (['string', 'number', 'int', 'array'].includes(node.kind)) {
			if (chance(rates.min)) node.min = node.kind === 'number' ? 0 : 1
			if (chance(rates.max)) node.max = node.kind === 'array' ? 50 : 255
		}
		return node
	}
	const leaf = (kind, depth) => {
		switch (kind) {
			case 'literal':
				return { kind, value: chance(0.85) ? pick(words) : Math.floor(random() * 10) }
			case 'enum':
				return { kind, values: words.slice(0, 2 + Math.floor(random() * 6)) }
			case 'id':
				return { kind, table: pick(tables) }
			case 'array':
				return checks({ kind, element: node(weighted(elementWeights), depth + 1) })
			case 'object':
				return object(depth + 1, 2 + Math.floor(random() * 5))
			case 'union':
				return union(depth + 1)
			case 'ref':
				return names.length ? { kind, name: pick(names) } : { kind: 'string' }
			default:
				return checks({ kind })
		}
	}
	// Deep nesting falls back to strings so the tree stays bounded.
	const node = (kind, depth) =>
		depth > 3 && ['object', 'array', 'union', 'ref'].includes(kind)
			? leaf('string', depth)
			: leaf(kind, depth)
	const union = (depth) => {
		const count = 2 + Math.floor(random() * 3)
		const members = Array.from({ length: count }, () => node(weighted(memberWeights), depth))
		return { kind: 'union', members }
	}
	const field = (kind, depth) => {
		const child = node(kind, depth)
		if (chance(rates.nullable)) child.nullable = true
		if (chance(rates.default) && !child.nullable && defaultFor(child) !== undefined)
			child.default = defaultFor(child)
		else if (chance(rates.optional)) child.optional = true
		return child
	}
	const object = (depth, width) => {
		const fields = {}
		for (let index = 0; index < width; index++) {
			const kind = weighted(fieldWeights)
			const key = kind === 'id' ? `ref${index}Id` : `${pick(words)}${index}`
			fields[key] = field(kind, depth)
		}
		return { kind: 'object', fields }
	}
	// Width 3-15, skewed toward 5-7.
	const width = () => 3 + Math.floor(random() ** 1.6 * 13)
	const add = (name, value) => {
		out.schemas.push({ name, node: value })
		names.push(name)
	}

	while (out.schemas.length < schemas) {
		const index = out.schemas.length
		const roll = random()
		if (roll < 0.86) {
			const name = `schema${index}`
			add(name, object(0, width()))
			// About one object in six is a table with its function args.
			if (chance(1 / 5) && out.schemas.length < schemas) {
				const args = object(0, 1 + Math.floor(random() * 5))
				args.fields.id = { kind: 'id', table: name }
				add(`schema${index}Args`, args)
				out.groups.push({
					name: `group${out.groups.length}`,
					table: name,
					args: `schema${index}Args`,
				})
			}
		} else if (roll < 0.93)
			add(`schema${index}`, { kind: 'enum', values: words.slice(0, 3 + (index % 5)) })
		else if (roll < 0.97) add(`schema${index}`, union(1))
		else add(`schema${index}`, checks({ kind: 'string' }))
	}
	return validate(out)
}

function defaultFor(node) {
	if (node.kind === 'boolean') return false
	if (node.kind === 'enum') return node.values[0]
	if ((node.kind === 'number' || node.kind === 'int') && node.min === undefined) return 0
	if (node.kind === 'string' && node.min === undefined && node.regex === undefined) return ''
	return undefined
}

function mulberry32(seed) {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}
