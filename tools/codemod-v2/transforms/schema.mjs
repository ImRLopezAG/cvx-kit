// Factories and chain methods: rewrites `z.<factory>(…)` to `k.<factory>(…)` and
// the chain methods applied to a proven schema, or records why a site stays Zod.
import { chainOf, isShadowed, outerChain, resolveBinding, unwrap, walk } from './ast.mjs'
import { addEdit, addInfo, addManual, addSkip } from './sites.mjs'
import { contractDefinition, isDomainContractCallee, isRegistrationCallee } from './consumer.mjs'
import { isFunctionDefinition } from './getters.mjs'

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
	['partialRecord', 'partialRecord'],
	['any', 'any'],
	['object', 'object'],
	['strictObject', 'strictObject'],
	['looseObject', 'looseObject'],
	['int', 'int'],
	['bigint', 'int64'],
	['discriminatedUnion', 'discriminatedUnion'],
	['json', 'json'],
	['unknown', 'any'],
	['email', 'email'],
	['url', 'url'],
	['custom', 'custom'],
	['void', 'void'],
	['instanceof', 'bytes'],
	['ipv4', 'ipv4'],
	['ipv6', 'ipv6'],
	['uuid', 'uuid'],
	['never', 'never'],
	['tuple', 'tuple'],
])

const ISO_FACTORIES = new Map([
	['date', 'isoDate'],
	['datetime', 'isoDateTime'],
])

const STRING_FORMATS = new Set([
	'httpUrl',
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
])

// `k.email()` / `k.url()` take a message, or these option keys; any other option (Zod's `pattern`,
// `normalize`, `abort`) has no `k` form.
const FORMAT_OPTIONS = new Map([
	['ipv4', new Set(['message', 'error'])],
	['ipv6', new Set(['message', 'error'])],
	['uuid', new Set(['message', 'error'])],
	['email', new Set(['message', 'error'])],
	['url', new Set(['message', 'error', 'protocol', 'hostname'])],
])

/** `z.custom<T>(guard?, message?)`: at most a guard and a message string or `{ message, error, path }`. */
function customArgumentsMap(call) {
	if (call.arguments.length > 2) return false
	if (call.arguments.length < 2) return true
	return optionsMap(unwrap(call.arguments[1]), CUSTOM_OPTIONS)
}

const CUSTOM_OPTIONS = new Set(['message', 'error', 'path'])

/** Whether an `email(...)` / `url(...)` call's argument is absent, a string, or an object of supported keys. */
function formatOptionsMap(name, call) {
	if (call.arguments.length === 0) return true
	if (call.arguments.length > 1) return false
	return optionsMap(unwrap(call.arguments[0]), FORMAT_OPTIONS.get(name))
}

function optionsMap(argument, allowed) {
	if (argument.type === 'Literal') return argument.value === String(argument.value)
	if (argument.type === 'TemplateLiteral') return true
	if (argument.type !== 'ObjectExpression') return false
	return argument.properties.every(
		(property) =>
			property.type === 'Property' &&
			!property.computed &&
			property.key.type === 'Identifier' &&
			allowed.has(property.key.name) &&
			// A function-valued `error` is Zod's error map, which k does not take.
			!(property.key.name === 'error' && /Function/.test(property.value.type)),
	)
}

const REPORTED_FACTORIES = new Map([
	['lazy', 'recursive'],
	['file', 'file'],
	['templateLiteral', 'template-literal'],
	['coerce', 'coerce'],
	['preprocess', 'preprocess'],
	['codec', 'codec'],
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
	'overwrite',
	'pipe',
	'describe',
	'extend',
	'partial',
	'strip',
	'strict',
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
	'catch',
	'email',
	'url',
	'loose',
	'ipv4',
	'ipv6',
	'uuid',
	'gt',
	'lt',
	'multipleOf',
	'rest',
])

/** Steps that build a new object from an object. */
const OBJECT_STEPS = new Set(['extend', 'pick', 'omit', 'partial', 'required'])

// Zod spellings of an inclusive bound, rewritten to the k method that expresses it.
const BOUND_ALIASES = new Map([['nonempty', ['min', '1']]])

// Zod spellings rewritten to the k method with the same behaviour.
const METHOD_RENAMES = new Map([
	['passthrough', 'loose'],
	['gte', 'min'],
	['lte', 'max'],
])

const TERMINAL_METHODS = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync'])

const REPORTED_METHODS = new Map([
	['catchall', 'catchall'],
	['superRefine', 'super-refine'],
	['meta', 'meta'],
	['brand', 'brand'],
	['readonly', 'readonly'],
])

/** Method names that make a member call on a proven schema a schema-chain site. */
export const SCHEMA_METHODS = new Set([
	...KEPT_METHODS,
	...TERMINAL_METHODS,
	...REPORTED_METHODS.keys(),
	'nullish',
	'gt',
	'lt',
	...BOUND_ALIASES.keys(),
	...METHOD_RENAMES.keys(),
	'pick',
	'omit',
	'normalize',
	'startsWith',
])

/** Whether `expression` evaluates to a Zod schema the codemod can prove. */
export function isSchemaExpression(ctx, expression, seen = new Set()) {
	const node = unwrap(expression)
	if (!node || seen.has(node)) return false
	seen.add(node)
	const { root, steps } = chainOf(node)
	if (root.type !== 'Identifier') return false
	if (steps.some((step) => step.kind === 'member' && TERMINAL_METHODS.has(step.name))) return false
	const binding = resolveBinding(root, ctx.parents)
	if (binding && binding.scope.type !== 'Program') {
		return (
			binding.kind === 'const' &&
			binding.path?.length === 0 &&
			isSchemaExpression(ctx, binding.init, seen)
		)
	}
	if (ctx.zodNamespaces.has(root.name)) {
		const first = steps[0]
		return first?.kind === 'member' && first.name !== null && !first.name.startsWith('Zod')
	}
	if (root.name === 'k' && ctx.hasK) {
		const first = steps[0]
		return first?.kind === 'member' && steps[1]?.kind === 'call'
	}
	if (ctx.kit.get(root.name)?.imported === 'zid' && steps[0]?.kind === 'call')
		return schemaTail(steps, 1)
	if (ctx.schemaFactories.has(root.name) && steps[0]?.kind === 'call') return schemaTail(steps, 1)
	if (tableSchemaPrefix(ctx, root, steps) > 0) return true
	const prefix = schemaMemberSteps(ctx, root, steps)
	if (prefix >= 0) return schemaTail(steps, prefix)
	return false
}

/** Number of member selections before a proven schema, or -1 if the path is unknown. */
export function schemaMemberSteps(ctx, root, steps) {
	let path = root.name
	const imported = ctx.imported.get(root.name)
	for (let index = 0; index <= steps.length; index++) {
		const local = (index === 0 && ctx.schemaBindings.has(path)) || ctx.schemaPaths?.has(path)
		const members = path.split('.').slice(1)
		const exported =
			imported?.imported === '*' ? members.join('.') : [imported?.imported, ...members].join('.')
		if (
			local ||
			(imported &&
				!ctx.owners.get(root.name)?.some((owner) => !owner.isType) &&
				ctx.options.run?.isK(ctx.path, imported.source, exported))
		)
			return index
		if (steps[index]?.kind !== 'member' || steps[index].name === null) break
		path += `.${steps[index].name}`
	}
	return -1
}

function schemaTail(steps, from) {
	for (let index = from; index < steps.length; index++) {
		const step = steps[index]
		if (step.kind !== 'member') return false
		if (step.name === 'shape' && steps[index + 1]?.kind === 'member') {
			index++
			continue
		}
		if (step.name === 'element') continue
		if (!DERIVED_METHODS.has(step.name) || steps[index + 1]?.kind !== 'call') return false
		index++
	}
	return true
}

const DERIVED_METHODS = new Set([
	...KEPT_METHODS,
	...BOUND_ALIASES.keys(),
	...METHOD_RENAMES.keys(),
	'nullish',
	'unwrap',
	'extend',
	'pick',
	'omit',
	'partial',
	'required',
	'optional',
	'nullable',
	'strict',
	'strip',
])

const TABLE_SCHEMA_MEMBERS = new Set([
	'storage',
	'schema',
	'doc',
	'insertSchema',
	'updateSchema',
	'commandInput',
	'publicDto',
])
const TABLE_SCHEMA_CALLS = new Set(['insert', 'update', 'dto', 'paginationOpts', 'pageDto'])

/** Resolve a table binding or selected relation table by its proven path. */
export function isTableExpression(ctx, expression) {
	const { root, steps } = chainOf(unwrap(expression))
	if (
		root.type !== 'Identifier' ||
		steps.some((step) => step.kind !== 'member' || step.name === null)
	)
		return false
	const path = [root.name, ...steps.map((step) => step.name)].join('.')
	const binding = resolveBinding(root, ctx.parents)
	if (binding && binding.scope.type !== 'Program') return false
	if (ctx.tableBindings.has(path) || ctx.tablePaths?.has(path)) return true
	if (binding?.kind !== 'import') return false
	const imported = [
		binding.imported === '*' ? '' : binding.imported,
		...steps.map((step) => step.name),
	]
		.filter(Boolean)
		.join('.')
	return ctx.options.run?.isTable(ctx.path, binding.source, imported) === true
}

function tableSchemaPrefix(ctx, root, steps) {
	for (let index = 0; index < steps.length; index++) {
		const expression = index === 0 ? root : steps[index - 1].node
		if (isTableExpression(ctx, expression)) {
			const count = tableSchemaSteps(steps.slice(index))
			if (count > 0) return index + count
		}
		if (steps[index].kind !== 'member') break
	}
	return 0
}

/** How many leading steps of a table-rooted chain select a schema, or 0 when none do. */
export function tableSchemaSteps(steps) {
	const first = steps[0]
	if (first?.kind !== 'member') return 0
	if (TABLE_SCHEMA_MEMBERS.has(first.name)) return 1
	if (first.name === 'shape' && steps[1]?.kind === 'member') return 2
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
	if (first.name === 'NEVER' && steps.length === 1) {
		// `z.NEVER` in a transform whose issues map directly becomes `k.NEVER`; otherwise the transform
		// step reports `transform-issue` for the whole callback.
		const callback = enclosingTransform(id, ctx.parents)
		if (callback === null) addSkip(ctx, unit, outer, 'unknown-factory')
		else if (transformIssuesMap(callback)) addEdit(unit, id, 'k', true)
		return
	}
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
	const call = steps[next].node
	const positional = new Map([
		['object', 1],
		['strictObject', 1],
		['looseObject', 1],
		['array', 1],
		['literal', 1],
		['union', 1],
		['record', 2],
		['partialRecord', 2],
		['discriminatedUnion', 2],
	])
	if (positional.has(first.name) && call.arguments.length > positional.get(first.name)) {
		addSkip(ctx, unit, span(next), 'factory-params')
		return
	}
	if (
		[
			'string',
			'number',
			'boolean',
			'null',
			'int',
			'bigint',
			'any',
			'unknown',
			'json',
			'ipv4',
			'ipv6',
			'uuid',
			'never',
		].includes(first.name) &&
		call.arguments.length > 0
	) {
		addSkip(ctx, unit, span(next), 'factory-params')
		return
	}
	if (first.name === 'tuple') {
		const items = unwrap(call.arguments[0])
		if (
			call.arguments.length > 2 ||
			items?.type !== 'ArrayExpression' ||
			items.elements.some(
				(item) => !item || item.type === 'SpreadElement' || !isSchemaExpression(ctx, item),
			) ||
			(call.arguments[1] && !isSchemaExpression(ctx, call.arguments[1]))
		) {
			addSkip(ctx, unit, span(next), 'tuple-arguments')
			return
		}
		if (
			[...items.elements, ...call.arguments.slice(1)].some(
				(item) => tupleSlot(ctx, item) !== 'required',
			)
		) {
			addSkip(ctx, unit, span(next), 'tuple-optionality')
			return
		}
	}
	if (first.name === 'literal') {
		const value = localConstant(ctx, call.arguments[0])
		if (
			value?.type === 'ArrayExpression' &&
			value.elements.length > 0 &&
			value.elements.every((item) => item?.type === 'Literal' && item.value === String(item.value))
		)
			target = 'enum'
		else if (
			!(
				value?.type === 'Literal' ||
				(value?.type === 'UnaryExpression' &&
					['-', '+'].includes(value.operator) &&
					value.argument.type === 'Literal') ||
				(value?.type === 'TemplateLiteral' && value.expressions.length === 0)
			)
		) {
			addSkip(ctx, unit, span(next), 'literal-array')
			return
		}
	}
	if (first.name === 'iso' && factory.name === 'datetime' && call.arguments.length === 0)
		addInfo(ctx, unit, span(next), 'iso-datetime-offset')
	if (first.name === 'record' || first.name === 'partialRecord')
		addInfo(ctx, unit, span(next), 'record-key-rule')
	if (first.name === 'union' && localConstant(ctx, call.arguments[0])?.type === 'ArrayExpression') {
		const members = localConstant(ctx, call.arguments[0]).elements
		if (members.length >= 2 && members.every((member) => isObjectSchema(ctx, member)))
			addInfo(ctx, unit, span(next), 'union-member-order')
	}
	if (first.name === 'iso' && call.arguments.length > 0) {
		const arg = unwrap(call.arguments[0])
		const offset =
			factory.name === 'datetime' &&
			call.arguments.length === 1 &&
			arg.type === 'ObjectExpression' &&
			arg.properties.length === 1 &&
			arg.properties[0].type === 'Property' &&
			!arg.properties[0].computed &&
			arg.properties[0].key.name === 'offset' &&
			arg.properties[0].value.value === true
		if (!offset) {
			addSkip(ctx, unit, span(next), 'iso-options')
			return
		}
		addEdit(unit, arg, '')
	}
	if (first.name === 'instanceof') {
		const arg = call.arguments[0]
		if (
			call.arguments.length !== 1 ||
			arg?.type !== 'Identifier' ||
			arg.name !== 'ArrayBuffer' ||
			ctx.owners.has('ArrayBuffer') ||
			ctx.imported.has('ArrayBuffer') ||
			isShadowed(arg, 'ArrayBuffer', ctx.parents)
		) {
			addSkip(ctx, unit, span(next), 'custom')
			return
		}
		addEdit(unit, arg, '')
		addInfo(ctx, unit, span(next), 'bytes-validator-narrowed')
	}
	if (first.name === 'void') {
		const parent = ctx.parents.get(outer)
		if (
			parent?.type !== 'Property' ||
			parent.value !== outer ||
			parent.computed ||
			!['returns', 'result'].includes(parent.key.name ?? parent.key.value) ||
			call.arguments.length !== 0 ||
			!isReturnsDefinition(ctx, parent)
		) {
			addSkip(ctx, unit, span(next), 'void-position')
			return
		}
	}
	if (first.name === 'enum' && call.arguments.length > 1) {
		addSkip(ctx, unit, span(next), 'enum-options')
		return
	}
	if (first.name === 'enum' && !stringEnumArgument(ctx, call.arguments[0])) {
		if (unwrap(call.arguments[0])?.type === 'CallExpression')
			addInfo(ctx, unit, span(next), 'enum-runtime-checked')
		else {
			addSkip(ctx, unit, span(next), 'enum-unproven')
			return
		}
	}
	if (first.name === 'custom' && !customArgumentsMap(steps[next].node)) {
		addSkip(ctx, unit, span(next), 'custom')
		return
	}
	if (FORMAT_OPTIONS.has(first.name) && !formatOptionsMap(first.name, steps[next].node)) {
		addSkip(ctx, unit, span(next), 'string-format')
		return
	}
	if (isShadowed(id, 'k', ctx.parents)) {
		addSkip(ctx, unit, span(next), 'k-shadowed')
		return
	}
	if (first.name === 'partialRecord') {
		// Zod's partialRecord with a string key is a plain record; `k.partialRecord` takes finite keys only.
		const keys = recordKeyKind(ctx, steps[next].node.arguments[0])
		if (keys === 'string') target = 'record'
		else if (keys !== 'literals') {
			addSkip(ctx, unit, span(next), 'partial-record-key')
			return
		}
	}
	addEdit(unit, id, 'k', true)
	if (factory !== first) {
		addEdit(unit, { start: first.node.property.start, end: factory.node.property.end }, target)
	} else if (target !== first.name) addEdit(unit, first.node.property, target)
	if (first.name === 'number' || first.name === 'int') {
		numberBounds(ctx, unit, steps, next, first, span(next))
	}
	processSteps(ctx, unit, steps, next + 1, outer, null)
}

/**
 * The kind of a record key argument: `'string'` for `z.string()` (no chained steps), `'literals'`
 * for `z.enum([...])`, `z.literal('…')` or a `z.union([...])` of those, else null (unproven).
 */
function recordKeyKind(ctx, argument) {
	const node = argument ? unwrap(argument) : null
	if (!node) return null
	const { root, steps } = chainOf(node)
	if (root.type !== 'Identifier' || !ctx.zodNamespaces.has(root.name)) return null
	const factory = steps[0]
	if (factory?.kind !== 'member' || steps[1]?.kind !== 'call' || steps.length !== 2) return null
	const args = steps[1].node.arguments
	if (factory.name === 'string') return 'string'
	if (factory.name === 'enum') return args[0]?.type === 'ArrayExpression' ? 'literals' : null
	if (factory.name === 'literal')
		return args[0]?.type === 'Literal' && args[0].value === String(args[0].value)
			? 'literals'
			: null
	if (factory.name === 'union' && args[0]?.type === 'ArrayExpression')
		return args[0].elements.every((element) => recordKeyKind(ctx, element) === 'literals')
			? 'literals'
			: null
	return null
}

/** Only proven required tuple positions can be represented by the kit. */
export function tupleSlot(ctx, expression, seen = new Set()) {
	const node = unwrap(expression)
	if (!node || seen.has(node)) return 'unknown'
	seen = new Set(seen).add(node)
	const { root, steps } = chainOf(node)
	if (root.type !== 'Identifier') return 'unknown'
	const binding = resolveBinding(root, ctx.parents)
	let state = 'unknown'
	let from = 0
	if (
		(ctx.zodNamespaces.has(root.name) || (root.name === 'k' && ctx.hasK)) &&
		steps[1]?.kind === 'call'
	) {
		state = steps[0].name === 'void' ? 'void' : 'required'
		from = 2
	} else if (ctx.kit?.get(root.name)?.imported === 'zid' && steps[0]?.kind === 'call') {
		state = 'required'
		from = 1
	} else if (binding?.kind === 'const' && binding.path?.length === 0) {
		state = tupleSlot(ctx, binding.init, seen)
	} else if (binding?.kind === 'import') {
		state = ctx.options.run?.tupleSlot?.(ctx.path, binding.source, binding.imported) ?? 'unknown'
		if (state === 'unknown' && ctx.options.run?.isK?.(ctx.path, binding.source, binding.imported))
			state = 'required'
	}
	for (let index = from; index < steps.length; index += 2) {
		const step = steps[index]
		if (step.kind !== 'member' || steps[index + 1]?.kind !== 'call') return 'unknown'
		if (['optional', 'nullish'].includes(step.name)) state = 'optional'
		else if (step.name === 'default') state = 'defaulted'
	}
	return state
}

/** Keep Zod's finite numbers; integers are already safe by default in k. */
function numberBounds(ctx, unit, steps, next, factory, site) {
	const numericSteps = []
	for (let index = next + 1; index < steps.length; index += 2) {
		const step = steps[index]
		if (step.kind !== 'member' || steps[index + 1]?.kind !== 'call') break
		if (step.name === 'transform' || step.name === 'pipe' || TERMINAL_METHODS.has(step.name)) break
		numericSteps.push({ step, call: steps[index + 1].node })
	}
	let integer = factory.name === 'int'
	for (const { step, call } of numericSteps) {
		if (step.name === 'int' || step.name === 'safe') {
			if (step.name === 'safe' && integer) {
				addEdit(unit, { start: step.node.object.end, end: call.end }, '')
			} else if (!integer && call.arguments.length === 0) {
				addEdit(unit, factory.node.property, 'int')
				addEdit(unit, { start: step.node.object.end, end: call.end }, '')
			} else if (step.name === 'safe') addEdit(unit, step.node.property, 'int')
			integer = true
		}
	}
	if (integer || numericSteps.some(({ step }) => step.name === 'finite')) return
	if (ctx.options.nativeNumberBounds) addInfo(ctx, unit, site, 'number-now-accepts-nan')
	else {
		const end = steps[next].node.end
		addEdit(unit, { start: end, end }, '.finite()')
		addInfo(ctx, unit, site, 'number-finite-preserved')
	}
}

/**
 * A chain rooted at a proven schema binding or a table boundary member. Returns
 * whether the chain builds a schema (rather than only parsing a value).
 */
export function processBoundChain(ctx, unit, id, table) {
	const outer = outerChain(id, ctx.parents)
	const { steps } = chainOf(outer)
	const tableFrom = tableSchemaPrefix(ctx, id, steps)
	let from = tableFrom > 0 ? tableFrom : table ? 0 : schemaMemberSteps(ctx, id, steps)
	if (id.name === 'k' && ctx.hasK && steps[0]?.kind === 'member' && steps[1]?.kind === 'call')
		from = 2
	while (from >= 0 && steps[from]?.kind === 'member') {
		if (steps[from].name === 'shape' && steps[from + 1]?.kind === 'member') from += 2
		else if (steps[from].name === 'element') from++
		else break
	}
	if (from < 0 || (table && from === 0)) return false
	const method = steps[from]
	if (method?.kind !== 'member' || steps[from + 1]?.kind !== 'call') return false
	unit.contexts.push(outer)
	if (TERMINAL_METHODS.has(method.name)) {
		processSteps(ctx, unit, steps, from, outer, null)
		return false
	}
	unit.boundSchema = true
	processSteps(
		ctx,
		unit,
		steps,
		from,
		outer,
		table ? false : ctx.numberBindings.has(id.name),
		ctx.integerBindings.has(id.name),
	)
	return true
}

/** Steps that record an object-level check; a derived object in `k` throws unless told what to do with it. */
const CHECK_STEPS = new Set(['refine', 'superRefine', 'check'])

/**
 * Whether the schema before step `end` of a chain carries an object-level check: a check step after
 * its last object-building step, or, with none, a check on the binding at its root.
 */
export function carriesObjectChecks(ctx, chain, end = chain.steps.length) {
	const { root, steps } = chain
	for (let index = end - 1; index >= 0; index--) {
		const step = steps[index]
		if (step.kind !== 'member') continue
		if (CHECK_STEPS.has(step.name)) return true
		if (OBJECT_STEPS.has(step.name)) return false
	}
	return root.type === 'Identifier' && ctx.refinedBindings.has(root.name)
}

/**
 * `number` is null for a chain whose number bounds `numberBounds` already handled (a Zod factory
 * chain), else whether the chain's root binding is proven to be a Zod number.
 */
function processSteps(ctx, unit, steps, from, outer, number, integer = false) {
	const chain = chainOf(outer)
	let index = from
	while (index < steps.length) {
		const step = steps[index]
		if (step.kind !== 'member' || step.name === null) return
		const call = steps[index + 1]?.kind === 'call' ? steps[index + 1].node : null
		const site = { start: step.node.property.start, end: (call ?? step.node).end }
		if (call && OBJECT_STEPS.has(step.name) && carriesObjectChecks(ctx, chain, index)) {
			addSkip(ctx, unit, site, 'derive-drops-checks')
			index += 2
			continue
		}
		if (!call) {
			if (step.name === 'element') {
				index++
				continue
			}
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
		// Numeric calls removed by numberBounds must not receive nested option edits.
		if (
			(step.name === 'safe' || step.name === 'int') &&
			unit.edits.some(
				(edit) => edit.text === '' && edit.start === step.node.object.end && edit.end === call.end,
			)
		) {
			index += 2
			continue
		}
		if (number && step.name === 'safe' && integer) {
			addEdit(unit, { start: step.node.object.end, end: call.end }, '')
			index += 2
			continue
		}
		if (TERMINAL_METHODS.has(step.name)) {
			if (step.name.startsWith('safeParse')) trackSafeParse(ctx, unit, steps, index, outer)
			return
		}
		if (step.name === 'refine' && asyncRefinement(ctx, call.arguments[0])) {
			addSkip(ctx, unit, site, 'refine-async')
			index += 2
			continue
		}
		if (
			['trim', 'toLowerCase', 'toUpperCase'].includes(step.name) &&
			hasStringCheck(ctx, { root: chain.root, steps: steps.slice(0, index) })
		)
			addInfo(ctx, unit, site, 'normalise-before-check')
		if (step.name === 'nullish' && call.arguments.length === 0) {
			addEdit(unit, step.node.property, 'nullable().optional')
		} else if (
			(step.name === 'gt' || step.name === 'lt') &&
			call.arguments.length >= 1 &&
			call.arguments.length <= 2 &&
			isZero(call.arguments[0])
		) {
			addEdit(unit, step.node.property, step.name === 'gt' ? 'positive' : 'negative')
			const bound = call.arguments[0]
			addEdit(unit, { start: bound.start, end: call.arguments[1]?.start ?? bound.end }, '')
			checkOptions(ctx, unit, call.arguments[1])
		} else if (step.name === 'rest') {
			if (
				call.arguments.length !== 1 ||
				!isSchemaExpression(ctx, call.arguments[0]) ||
				!uncheckedTuple(ctx, step.node.object)
			)
				addSkip(ctx, unit, site, 'tuple-arguments')
			else if (tupleSlot(ctx, call.arguments[0]) !== 'required')
				addSkip(ctx, unit, site, 'tuple-optionality')
		} else if (['gt', 'lt', 'multipleOf'].includes(step.name) && !numberChain(ctx, chain)) {
			addSkip(ctx, unit, site, 'unknown-method')
		} else if (step.name === 'multipleOf' && invalidDivisor(call.arguments[0])) {
			addSkip(ctx, unit, site, 'multiple-of-divisor')
		} else if (BOUND_ALIASES.has(step.name) && call.arguments.length <= 1) {
			const [method, bound] = BOUND_ALIASES.get(step.name)
			addEdit(unit, step.node.property, method)
			const first = call.arguments[0]
			const at = first ? first.start : call.end - 1
			addEdit(unit, { start: at, end: at }, first ? `${bound}, ` : bound)
		} else if (
			(step.name === 'gte' || step.name === 'lte') &&
			call.arguments.length >= 1 &&
			call.arguments.length <= 2
		) {
			addEdit(unit, step.node.property, METHOD_RENAMES.get(step.name))
			checkOptions(ctx, unit, call.arguments[1])
		} else if (METHOD_RENAMES.has(step.name) && call.arguments.length === 0) {
			addEdit(unit, step.node.property, METHOD_RENAMES.get(step.name))
		} else if (step.name === 'normalize') {
			const arg = call.arguments[0]
			if (
				call.arguments.length === 0 ||
				(call.arguments.length === 1 &&
					arg.type === 'Literal' &&
					['NFC', 'NFD', 'NFKC', 'NFKD'].includes(arg.value))
			) {
				addEdit(
					unit,
					{ start: step.node.property.start, end: call.end },
					`overwrite(value => value.normalize(${arg ? ctx.source.slice(arg.start, arg.end) : ''}))`,
				)
			} else addSkip(ctx, unit, site, 'normalize-options')
		} else if (step.name === 'startsWith') {
			addSkip(ctx, unit, site, 'string-prefix')
		} else if (
			step.name === 'pick' ||
			step.name === 'omit' ||
			((step.name === 'partial' || step.name === 'required') && call.arguments.length > 0)
		) {
			maskStep(ctx, unit, call, site)
		} else if (step.name === 'catch' && readsZodCatchContext(call)) {
			addSkip(ctx, unit, site, 'catch')
		} else if (step.name === 'transform' && !transformIssuesMap(call.arguments[0])) {
			addSkip(ctx, unit, site, 'transform-issue')
		} else if (step.name === 'check' && isZodCheck(call)) {
			addSkip(ctx, unit, site, 'zod-check')
		} else if (REPORTED_METHODS.has(step.name)) {
			addSkip(ctx, unit, site, REPORTED_METHODS.get(step.name))
		} else if (
			STRING_FORMATS.has(step.name) ||
			(FORMAT_OPTIONS.has(step.name) && !formatOptionsMap(step.name, call))
		) {
			addSkip(ctx, unit, site, 'string-format')
		} else if (!KEPT_METHODS.has(step.name)) {
			addSkip(ctx, unit, site, 'unknown-method')
		} else if (OPTIONS_ARGUMENT.has(step.name)) {
			checkOptions(ctx, unit, call.arguments[OPTIONS_ARGUMENT.get(step.name)])
		}
		if (number && step.name === 'safe') addEdit(unit, step.node.property, 'int')
		if (step.name === 'int' || step.name === 'safe') integer = true

		index += 2
	}
}

function isZero(argument) {
	const node = unwrap(argument)
	return node.type === 'Literal' && (node.value === 0 || node.bigint === '0')
}

function numberChain(ctx, { root, steps }, seen = new Set()) {
	if (root.type !== 'Identifier' || seen.has(root)) return false
	seen = new Set(seen).add(root)
	if (ctx.numberBindings.has(root.name)) return true
	if (
		(ctx.zodNamespaces.has(root.name) || (root.name === 'k' && ctx.hasK)) &&
		['number', 'int'].includes(steps[0]?.name)
	)
		return true
	const binding = resolveBinding(root, ctx.parents)
	return (
		binding?.kind === 'const' &&
		binding.path?.length === 0 &&
		binding.init &&
		numberChain(ctx, chainOf(unwrap(binding.init)), seen)
	)
}

function uncheckedTuple(ctx, expression, seen = new Set()) {
	const node = unwrap(expression)
	if (!node || seen.has(node)) return false
	seen = new Set(seen).add(node)
	const { root, steps } = chainOf(node)
	if (root.type !== 'Identifier') return false
	if (
		(ctx.zodNamespaces.has(root.name) || (root.name === 'k' && ctx.hasK)) &&
		steps[0]?.name === 'tuple' &&
		steps[1]?.kind === 'call'
	)
		return steps
			.slice(2)
			.every((step, index) => (index % 2 === 0 ? step.name === 'rest' : step.kind === 'call'))
	const binding = resolveBinding(root, ctx.parents)
	return (
		steps.length === 0 &&
		binding?.kind === 'const' &&
		binding.path?.length === 0 &&
		uncheckedTuple(ctx, binding.init, seen)
	)
}

/** The argument index of a check's message or options object. */
const OPTIONS_ARGUMENT = new Map([
	['gt', 1],
	['lt', 1],
	['multipleOf', 1],
	['ipv4', 0],
	['ipv6', 0],
	['uuid', 0],
	['refine', 1],
	['min', 1],
	['max', 1],
	['length', 1],
	['regex', 1],
	['int', 0],
	['positive', 0],
	['negative', 0],
	['nonnegative', 0],
	['nonpositive', 0],
	['finite', 0],
	['safe', 0],
])

function invalidDivisor(argument) {
	const node = unwrap(argument)
	if (!node) return true
	if (node.type === 'Literal' && node.value !== Object(node.value))
		return !(Number.isFinite(node.value) && node.value > 0)
	if (node.type === 'Identifier' && ['NaN', 'Infinity'].includes(node.name)) return true
	if (node.type === 'UnaryExpression' && ['-', '+'].includes(node.operator)) {
		const value = unwrap(node.argument)
		if (value.type === 'Literal')
			return !(node.operator === '+' && Number.isFinite(value.value) && value.value > 0)
		return value.type === 'Identifier' && ['NaN', 'Infinity'].includes(value.name)
	}
	return false
}

/**
 * Zod 4 spells a check's message `error`; `k` reads `message` (and accepts `error` as a string
 * alias). An inline `error: '…'` becomes `message: '…'`; a function-valued `error` is Zod's error map,
 * which `k` does not support. Options passed by reference cannot be read, so they are reported.
 */
function checkOptions(ctx, unit, argument) {
	if (!argument) return
	const node = unwrap(argument)
	if (node.type === 'Identifier' || node.type === 'MemberExpression') {
		addInfo(ctx, unit, argument, 'check-options-by-reference')
		return
	}
	if (node.type !== 'ObjectExpression') return
	const keyOf = (property) =>
		property.type === 'Property' && !property.computed
			? property.key.type === 'Identifier'
				? property.key.name
				: property.key.value
			: null
	if (node.properties.some((property) => keyOf(property) === 'message')) return
	for (const property of node.properties) {
		if (keyOf(property) !== 'error') continue
		const value = unwrap(property.value)
		// A non-function value read by reference is renamed too: k throws at declaration if it is a function.
		if (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression') {
			addSkip(ctx, unit, property, 'error-map')
			continue
		}
		if (property.shorthand) addEdit(unit, property, `message: error`)
		else addEdit(unit, property.key, 'message')
	}
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

/**
 * `k`'s fallback callback receives `{ issues, input }`; Zod's context also has `value` and `error`,
 * so a callback reading those on its parameter stays Zod.
 */
function readsZodCatchContext(call) {
	const callback = call.arguments[0]
	if (call.arguments.length !== 1) return true
	if (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression')
		return false
	if (callback.params.length === 0) return false
	const param = callback.params[0]
	if (param.type !== 'Identifier') {
		if (param.type !== 'ObjectPattern') return true
		return param.properties.some(
			(property) =>
				property.type !== 'Property' ||
				property.key.type !== 'Identifier' ||
				(property.key.name !== 'issues' && property.key.name !== 'input'),
		)
	}
	let zodForm = false
	walk(callback.body, (node) => {
		if (
			node.type === 'MemberExpression' &&
			!node.computed &&
			node.object.type === 'Identifier' &&
			node.object.name === param.name &&
			(node.property.name === 'value' || node.property.name === 'error')
		)
			zodForm = true
	})
	return zodForm
}

/**
 * Whether a transform callback's use of Zod's context maps directly onto `k`'s: every use of the
 * second parameter is `ctx.addIssue({ code: 'custom', message, path? })` with an inline object. A
 * callback without a second parameter (or a callback passed by reference) maps trivially.
 */
function transformIssuesMap(callback) {
	if (
		!callback ||
		(callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression')
	)
		return true
	if (callback.params.length < 2) return true
	const param = callback.params[1]
	if (param.type !== 'Identifier') return false
	let direct = 0
	let uses = 0
	walk(callback.body, (node) => {
		if (node.type === 'Identifier' && node.name === param.name) uses += 1
		if (
			node.type === 'CallExpression' &&
			node.callee.type === 'MemberExpression' &&
			!node.callee.computed &&
			node.callee.object.type === 'Identifier' &&
			node.callee.object.name === param.name &&
			node.callee.property.name === 'addIssue' &&
			node.arguments.length === 1 &&
			isDirectIssue(node.arguments[0])
		)
			direct += 1
	})
	return uses === direct
}

function isDirectIssue(issue) {
	if (issue.type !== 'ObjectExpression') return false
	let custom = false
	for (const property of issue.properties) {
		if (property.type !== 'Property' || property.computed || property.key.type !== 'Identifier')
			return false
		const name = property.key.name
		if (name === 'code') {
			if (property.value.type !== 'Literal' || property.value.value !== 'custom') return false
			custom = true
		} else if (name !== 'message' && name !== 'path') return false
	}
	return custom
}

/** The callback of the nearest enclosing `.transform(callback)`, or null. */
function enclosingTransform(node, parents) {
	for (let current = parents.get(node); current; current = parents.get(current)) {
		if (current.type !== 'ArrowFunctionExpression' && current.type !== 'FunctionExpression')
			continue
		const call = parents.get(current)
		if (
			call?.type === 'CallExpression' &&
			call.arguments[0] === current &&
			call.callee.type === 'MemberExpression' &&
			!call.callee.computed &&
			call.callee.property.name === 'transform'
		)
			return current
		return null
	}
	return null
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
	const keys = constantMaskKeys(ctx, mask)
	if (!keys || keys.length === 0) {
		addManual(ctx, unit, site, 'mask-dynamic')
		return
	}
	addEdit(unit, mask, keys.map((key) => `'${key.replace(/[\\']/g, '\\$&')}'`).join(', '))
}

/** Resolve only lexical const object masks, including constants exported by another file. */
export function constantMaskKeys(ctx, expression) {
	const node = unwrap(expression)
	if (node?.type === 'ObjectExpression') return maskKeys(node)
	if (node?.type !== 'Identifier') return null
	const binding = resolveBinding(node, ctx.parents)
	if (binding?.kind === 'const' && binding.path?.length === 0) {
		const init = unwrap(binding.init)
		return init?.type === 'ObjectExpression' ? maskKeys(init) : null
	}
	if (binding?.kind === 'import')
		return ctx.options.run?.maskKeys(ctx.path, binding.source, binding.imported) ?? null
	return null
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

/** Only enum values proven to be strings can use the kit's enum object form. */
export function stringEnumArgument(ctx, argument, seen = new Set(), arrayOnly = false) {
	const node = unwrap(argument)
	if (!node || seen.has(node)) return false
	const nextSeen = new Set(seen).add(node)
	if (node.type === 'ArrayExpression')
		return node.elements.every((element) =>
			element?.type === 'SpreadElement'
				? stringEnumArgument(ctx, element.argument, nextSeen, true)
				: unwrap(element)?.type === 'Literal' &&
					unwrap(element).value === String(unwrap(element).value),
		)
	if (
		node.type === 'CallExpression' &&
		node.callee.type === 'MemberExpression' &&
		!node.callee.computed &&
		node.callee.object.name === 'Object' &&
		node.callee.property.name === 'freeze' &&
		node.arguments.length === 1 &&
		!resolveBinding(node.callee.object, ctx.parents)
	)
		return stringEnumArgument(ctx, node.arguments[0], nextSeen, arrayOnly)
	if (arrayOnly && node.type === 'ObjectExpression') return false
	if (node.type === 'ObjectExpression')
		return node.properties.every(
			(property) =>
				property.type === 'Property' &&
				!property.computed &&
				property.value.type === 'Literal' &&
				property.value.value === String(property.value.value),
		)
	if (node.type !== 'Identifier') return false
	const binding = ctx.parents ? resolveBinding(node, ctx.parents) : null
	if (binding) {
		if (binding.kind === 'enum') return !arrayOnly && stringEnumMembers(binding.node)
		if (binding.kind === 'const' && binding.path?.length === 0)
			return stringEnumArgument(ctx, binding.init, nextSeen, arrayOnly)
		if (binding.kind === 'import')
			return (
				ctx.options.run?.isStringEnum(ctx.path, binding.source, binding.imported, arrayOnly) ===
				true
			)
		return false
	}
	for (const statement of ctx.program.body) {
		const declaration = statement.declaration ?? statement
		if (declaration.type === 'TSEnumDeclaration' && declaration.id.name === node.name) {
			if (arrayOnly) return false
			return stringEnumMembers(declaration)
		}
		if (declaration.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue
		const found = declaration.declarations.find((item) => item.id.name === node.name)
		if (found) return stringEnumArgument(ctx, found.init, nextSeen, arrayOnly)
	}
	const imported = ctx.imported.get(node.name)
	return imported
		? ctx.options.run?.isStringEnum(ctx.path, imported.source, imported.imported, arrayOnly) ===
				true
		: false
}

function stringEnumMembers(declaration) {
	return (declaration.body?.members ?? declaration.members).every(
		(member) =>
			member.initializer?.type === 'Literal' &&
			member.initializer.value === String(member.initializer.value),
	)
}

/** A returns field belongs to a function definition or resolved contract factory call. */
function isReturnsDefinition(ctx, property) {
	const object = ctx.parents.get(property)
	const call = ctx.parents.get(object)
	if (object?.type !== 'ObjectExpression') return false
	const key = property.key.name ?? property.key.value
	if (key === 'returns')
		return (
			call?.type === 'CallExpression' &&
			call.arguments.includes(object) &&
			(isFunctionDefinition(object, call) || isRegistrationCallee(ctx, call.callee))
		)
	if (call?.type === 'CallExpression' && isFunctionDefinition(object, call)) {
		const callee = unwrap(call.callee)
		return (
			callee.type === 'MemberExpression' &&
			!callee.computed &&
			['command', 'query'].includes(callee.property.name)
		)
	}
	const operation = ctx.parents.get(object)
	const operations = ctx.parents.get(operation)
	const group = ctx.parents.get(operations)
	const definition = ctx.parents.get(group)
	let factory = ctx.parents.get(definition)
	while (factory && unwrap(factory) === definition) factory = ctx.parents.get(factory)
	if (factory?.type === 'ReturnStatement') factory = ctx.parents.get(ctx.parents.get(factory))
	if (factory?.type === 'ArrowFunctionExpression') factory = ctx.parents.get(factory)
	return (
		operation?.type === 'Property' &&
		!operation.computed &&
		operation.value === object &&
		operations?.type === 'ObjectExpression' &&
		group?.type === 'Property' &&
		!group.computed &&
		['commands', 'queries'].includes(group.key.name ?? group.key.value) &&
		definition?.type === 'ObjectExpression' &&
		factory?.type === 'CallExpression' &&
		contractDefinition(factory.arguments[0]) === definition &&
		isDomainContractCallee(ctx, factory.callee)
	)
}

/** Follow visible callback bindings and returned Promise constructors or calls. */
function asyncRefinement(ctx, expression, seen = new Set()) {
	const node = unwrap(expression)
	if (!node || seen.has(node)) return false
	seen.add(node)
	if (node.type === 'Identifier') {
		const binding = resolveBinding(node, ctx.parents)
		if (binding?.init) return asyncRefinement(ctx, binding.init, seen)
		let found = false
		walk(ctx.program, (item) => {
			if (item.type === 'FunctionDeclaration' && item.id?.name === node.name)
				found ||= asyncRefinement(ctx, item, seen)
		})
		return found
	}
	if (/Function/.test(node.type)) {
		if (node.async) return true
		if (node.body.type !== 'BlockStatement') return asyncRefinement(ctx, node.body, seen)
		let found = false
		walk(node.body, (item) => {
			if (item.type === 'ReturnStatement') found ||= asyncRefinement(ctx, item.argument, seen)
		})
		return found
	}
	if (
		node.type === 'NewExpression' &&
		node.callee.type === 'Identifier' &&
		node.callee.name === 'Promise'
	)
		return true
	if (node.type === 'CallExpression') {
		const { root } = chainOf(node)
		return (
			root.type === 'Identifier' &&
			(root.name === 'Promise' || asyncRefinement(ctx, node.callee, seen))
		)
	}
	return false
}

function isObjectSchema(ctx, expression, seen = new Set()) {
	const node = unwrap(expression)
	if (!node || seen.has(node)) return false
	seen.add(node)
	const { root, steps } = chainOf(node)
	if (root.type !== 'Identifier') return false
	if (ctx.zodNamespaces.has(root.name) || (root.name === 'k' && ctx.hasK))
		return ['object', 'strictObject', 'looseObject'].includes(steps[0]?.name)
	const binding = resolveBinding(root, ctx.parents)
	return Boolean(binding?.init && isObjectSchema(ctx, binding.init, seen))
}

/** Follow lexical constant aliases without evaluating arbitrary expressions. */
function localConstant(ctx, expression, seen = new Set()) {
	const node = unwrap(expression)
	if (!node || seen.has(node)) return null
	if (node.type !== 'Identifier') return node
	const binding = resolveBinding(node, ctx.parents)
	return binding?.kind === 'const' && binding.path?.length === 0
		? localConstant(ctx, binding.init, new Set(seen).add(node))
		: node
}

function hasStringCheck(ctx, chain, seen = new Set()) {
	if (
		chain.steps.some(
			(step) => step.kind === 'member' && ['min', 'max', 'length', 'regex'].includes(step.name),
		)
	)
		return true
	if (chain.root.type !== 'Identifier' || seen.has(chain.root)) return false
	const binding = resolveBinding(chain.root, ctx.parents)
	if (
		binding?.kind !== 'const' ||
		binding.path?.length !== 0 ||
		!isSchemaExpression(ctx, binding.init)
	)
		return false
	return hasStringCheck(ctx, chainOf(unwrap(binding.init)), new Set(seen).add(chain.root))
}
