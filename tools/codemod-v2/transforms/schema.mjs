// Factories and chain methods: rewrites `z.<factory>(…)` to `k.<factory>(…)` and
// the chain methods applied to a proven schema, or records why a site stays Zod.
import { chainOf, isShadowed, outerChain, unwrap, walk } from './ast.mjs'
import { addEdit, addSkip } from './sites.mjs'

const FACTORIES = new Map([
	['string', 'string'],
	['number', 'number'],
	['boolean', 'boolean'],
	['null', 'null'],
	['literal', 'literal'],
	['enum', 'enum'],
	['array', 'array'],
	['union', 'union'],
	['record', 'record'],
	['any', 'any'],
	['object', 'object'],
	['strictObject', 'object'],
	['int', 'int'],
	['bigint', 'int64'],
	['discriminatedUnion', 'discriminatedUnion'],
	['json', 'json'],
	['unknown', 'any'],
])

const ISO_FACTORIES = new Map([
	['date', 'isoDate'],
	['datetime', 'isoDateTime'],
])

const STRING_FORMATS = new Set([
	'email',
	'url',
	'httpUrl',
	'uuid',
	'uuidv4',
	'uuidv6',
	'uuidv7',
	'guid',
	'cuid',
	'cuid2',
	'ulid',
	'xid',
	'ksuid',
	'nanoid',
	'ipv4',
	'ipv6',
	'cidrv4',
	'cidrv6',
	'mac',
	'emoji',
	'base64',
	'base64url',
	'hex',
	'hash',
	'jwt',
	'e164',
	'hostname',
	'stringFormat',
	'templateLiteral',
	'file',
])

const REPORTED_FACTORIES = new Map([
	['looseObject', 'loose-object'],
	['lazy', 'recursive'],
	['tuple', 'tuple'],
	['custom', 'custom'],
	['instanceof', 'custom'],
	['coerce', 'coerce'],
	['preprocess', 'coerce'],
	['codec', 'coerce'],
	['toJSONSchema', 'json-schema'],
])

const KEPT_METHODS = new Set([
	'optional',
	'nullable',
	'min',
	'max',
	'length',
	'regex',
	'trim',
	'toLowerCase',
	'toUpperCase',
	'int',
	'default',
	'refine',
	'transform',
	'pipe',
	'describe',
	'extend',
	'partial',
	'strip',
	'unwrap',
	'positive',
	'negative',
	'nonnegative',
	'nonpositive',
	'finite',
	'safe',
	'required',
	'keyof',
	'exclude',
	'extract',
	'removeDefault',
	'check',
])

/** Steps that build a new object from an object, whose strictness `.strip()` must restate. */
const OBJECT_STEPS = new Set(['extend', 'pick', 'omit', 'partial', 'required'])

// Zod spellings of an inclusive bound, rewritten to the k method that expresses it.
const BOUND_ALIASES = new Map([['nonempty', ['min', '1']]])

const TERMINAL_METHODS = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync'])

const REPORTED_METHODS = new Map([
	['catchall', 'loose-object'],
	['passthrough', 'loose-object'],
	['catch', 'catch'],
	['superRefine', 'super-refine'],
	['meta', 'meta'],
	['brand', 'brand'],
	['readonly', 'brand'],
])

/** Method names that make a member call on a proven schema a schema-chain site. */
export const SCHEMA_METHODS = new Set([
	...KEPT_METHODS,
	...TERMINAL_METHODS,
	...REPORTED_METHODS.keys(),
	'nullish',
	'strict',
	...BOUND_ALIASES.keys(),
	'pick',
	'omit',
])

/** Whether `expression` evaluates to a Zod schema the codemod can prove. */
export function isSchemaExpression(ctx, expression) {
	const node = unwrap(expression)
	if (!node) return false
	const { root, steps } = chainOf(node)
	if (root.type !== 'Identifier') return false
	if (steps.some((step) => step.kind === 'member' && TERMINAL_METHODS.has(step.name))) return false
	if (ctx.zodNamespaces.has(root.name)) {
		const first = steps[0]
		return first?.kind === 'member' && first.name !== null && !first.name.startsWith('Zod')
	}
	if (root.name === 'k' && ctx.hasK) {
		const first = steps[0]
		return first?.kind === 'member' && steps[1]?.kind === 'call'
	}
	if (ctx.schemaBindings.has(root.name)) return steps.length === 0 || steps[0].kind === 'member'
	if (ctx.tableBindings.has(root.name)) return tableSchemaSteps(steps) > 0
	return false
}

const TABLE_SCHEMA_MEMBERS = new Set([
	'storage',
	'schema',
	'insertSchema',
	'updateSchema',
	'commandInput',
	'publicDto',
])
const TABLE_SCHEMA_CALLS = new Set(['insert', 'update', 'dto'])

/** How many leading steps of a table-rooted chain select a schema, or 0 when none do. */
export function tableSchemaSteps(steps) {
	const first = steps[0]
	if (first?.kind !== 'member') return 0
	if (TABLE_SCHEMA_MEMBERS.has(first.name)) return 1
	return TABLE_SCHEMA_CALLS.has(first.name) && steps[1]?.kind === 'call' ? 2 : 0
}

/** A chain rooted at the Zod namespace binding `id`. */
export function processZodChain(ctx, unit, id) {
	const outer = outerChain(id, ctx.parents)
	unit.contexts.push(outer)
	unit.zodValue = true
	const { steps } = chainOf(outer)
	const first = steps[0]
	if (!first || first.kind !== 'member' || first.name === null) {
		addSkip(ctx, unit, outer, 'unknown-factory')
		return
	}
	const siteEnd = (index) =>
		steps[index]?.kind === 'call' ? steps[index].node : steps[index - 1].node
	const span = (index) => ({ start: id.start, end: siteEnd(index).end })
	if (first.name.startsWith('Zod')) {
		addSkip(ctx, unit, first.node, 'zod-type')
		return
	}
	const reported = REPORTED_FACTORIES.get(first.name)
	if (reported) {
		addSkip(ctx, unit, span(first.name === 'coerce' ? 2 : 1), reported)
		return
	}
	if (STRING_FORMATS.has(first.name)) {
		addSkip(ctx, unit, span(1), 'string-format')
		return
	}
	let target = FACTORIES.get(first.name)
	let factory = first
	let next = 1
	if (first.name === 'iso') {
		factory = steps[1]
		next = 2
		target = factory?.kind === 'member' ? ISO_FACTORIES.get(factory.name) : undefined
		if (!target) {
			addSkip(ctx, unit, span(2), 'string-format')
			return
		}
	}
	if (!target || steps[next]?.kind !== 'call') {
		addSkip(ctx, unit, span(next), 'unknown-factory')
		return
	}
	if (isShadowed(id, 'k', ctx.parents)) {
		addSkip(ctx, unit, span(next), 'k-shadowed')
		return
	}
	addEdit(unit, id, 'k', true)
	if (factory !== first) {
		addEdit(unit, { start: first.node.property.start, end: factory.node.property.end }, target)
	} else if (target !== first.name) addEdit(unit, first.node.property, target)
	if (first.name === 'object' || first.name === 'strictObject') {
		unit.objectSites.push({
			site: span(next),
			end: steps[next].node.end,
			strict: first.name === 'strictObject' || setsStrictness(steps, next + 1),
			derived: false,
		})
	}
	processSteps(ctx, unit, steps, next + 1, outer)
}

/**
 * A chain rooted at a proven schema binding or a table boundary member. Returns
 * whether the chain builds a schema (rather than only parsing a value).
 */
export function processBoundChain(ctx, unit, id, table) {
	const outer = outerChain(id, ctx.parents)
	const { steps } = chainOf(outer)
	const from = table ? tableSchemaSteps(steps) : 0
	if (table && from === 0) return false
	const method = steps[from]
	if (method?.kind !== 'member' || steps[from + 1]?.kind !== 'call') return false
	unit.contexts.push(outer)
	if (TERMINAL_METHODS.has(method.name)) {
		processSteps(ctx, unit, steps, from, outer)
		return false
	}
	unit.boundSchema = true
	processSteps(ctx, unit, steps, from, outer)
	return true
}

function processSteps(ctx, unit, steps, from, outer) {
	let index = from
	while (index < steps.length) {
		const step = steps[index]
		if (step.kind !== 'member' || step.name === null) return
		const call = steps[index + 1]?.kind === 'call' ? steps[index + 1].node : null
		const site = { start: step.node.property.start, end: (call ?? step.node).end }
		if (!call) {
			if (step.name === 'shape') {
				index += 2
				continue
			}
			if (step.name === 'options') return
			addSkip(
				ctx,
				unit,
				site,
				step.name === 'def' || step.name === '_zod' ? 'zod-introspection' : 'unknown-method',
			)
			return
		}
		if (TERMINAL_METHODS.has(step.name)) {
			if (step.name.startsWith('safeParse')) trackSafeParse(ctx, unit, steps, index, outer)
			return
		}
		if (step.name === 'nullish' && call.arguments.length === 0) {
			addEdit(unit, step.node.property, 'nullable().optional')
		} else if (BOUND_ALIASES.has(step.name) && call.arguments.length <= 1) {
			const [method, bound] = BOUND_ALIASES.get(step.name)
			addEdit(unit, step.node.property, method)
			const first = call.arguments[0]
			const at = first ? first.start : call.end - 1
			addEdit(unit, { start: at, end: at }, first ? `${bound}, ` : bound)
		} else if (step.name === 'strict' && call.arguments.length === 0) {
			addEdit(unit, { start: step.node.object.end, end: call.end }, '')
		} else if (step.name === 'pick' || step.name === 'omit') {
			maskStep(ctx, unit, call, site)
		} else if (step.name === 'check' && isZodCheck(call)) {
			addSkip(ctx, unit, site, 'zod-check')
		} else if (REPORTED_METHODS.has(step.name)) {
			addSkip(ctx, unit, site, REPORTED_METHODS.get(step.name))
		} else if (STRING_FORMATS.has(step.name)) {
			addSkip(ctx, unit, site, 'string-format')
		} else if (!KEPT_METHODS.has(step.name)) {
			addSkip(ctx, unit, site, 'unknown-method')
		}
		if (OBJECT_STEPS.has(step.name)) {
			unit.objectSites.push({
				site,
				end: call.end,
				strict: setsStrictness(steps, index + 2),
				derived: true,
			})
		}
		index += 2
	}
}

/** Whether a later step states the object's unknown-key handling (`.strict()` or `.strip()`). */
function setsStrictness(steps, from) {
	for (let index = from; index < steps.length; index++) {
		const step = steps[index]
		if (step.kind !== 'member') continue
		if (step.name === 'strict' || step.name === 'strip') return true
		if (OBJECT_STEPS.has(step.name)) return false
	}
	return false
}

/**
 * Zod's `.check(…)` takes check functions (`z.minLength(3)`) or a callback
 * reading `ctx.value` and pushing to `ctx.issues`; `k`'s callback takes
 * `(value, ctx)`. A one-parameter callback that reads `.value` or `.issues` on
 * its parameter is the Zod form.
 */
function isZodCheck(call) {
	const callback = call.arguments[0]
	if (call.arguments.length !== 1 || !callback) return true
	if (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression')
		return false
	if (callback.params.length !== 1 || callback.params[0].type !== 'Identifier') return false
	const name = callback.params[0].name
	let zodForm = false
	walk(callback.body, (node) => {
		if (
			node.type === 'MemberExpression' &&
			!node.computed &&
			node.object.type === 'Identifier' &&
			node.object.name === name &&
			(node.property.name === 'value' || node.property.name === 'issues')
		)
			zodForm = true
	})
	return zodForm
}

/** `.pick({ a: true })` → `.pick('a')`; string arguments are already the v2 form. */
function maskStep(ctx, unit, call, site) {
	const args = call.arguments
	if (
		args.length > 0 &&
		args.every((arg) => arg.type === 'Literal' && arg.value === String(arg.value))
	) {
		return
	}
	const mask = args.length === 1 ? args[0] : null
	const keys = mask?.type === 'ObjectExpression' ? maskKeys(mask) : null
	if (!keys || keys.length === 0) {
		addSkip(ctx, unit, site, 'mask-dynamic')
		return
	}
	addEdit(unit, mask, keys.map((key) => `'${key.replace(/[\\']/g, '\\$&')}'`).join(', '))
}

function maskKeys(mask) {
	const keys = []
	for (const property of mask.properties) {
		if (property.type !== 'Property' || property.computed || property.kind !== 'init') return null
		if (property.value.type !== 'Literal' || property.value.value !== true) return null
		if (property.key.type === 'Identifier') keys.push(property.key.name)
		else if (property.key.type === 'Literal' && property.key.value === String(property.key.value)) {
			keys.push(property.key.value)
		} else return null
	}
	return keys
}

/** `.error` on a safeParse result reads Zod's error object, which k does not return. */
function trackSafeParse(ctx, unit, steps, index, outer) {
	const after = steps[index + 2]
	if (after?.kind === 'member' && after.name === 'error') {
		addSkip(ctx, unit, after.node.property, 'zod-introspection')
		return
	}
	if (index + 2 < steps.length) return
	let holder = ctx.parents.get(outer)
	if (holder?.type === 'AwaitExpression') holder = ctx.parents.get(holder)
	if (holder?.type !== 'VariableDeclarator') return
	if (holder.id.type === 'Identifier') {
		unit.safeResults.add(holder.id.name)
		return
	}
	if (holder.id.type !== 'ObjectPattern') return
	for (const property of holder.id.properties) {
		if (
			property.type === 'Property' &&
			property.key.type === 'Identifier' &&
			property.key.name === 'error'
		) {
			addSkip(ctx, unit, property, 'zod-introspection')
		}
	}
}
