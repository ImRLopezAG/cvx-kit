import { z } from 'zod'
import { v, type GenericValidator } from 'convex/values'
import { vRequired } from 'convex-helpers/validators'
import { zid } from 'convex-helpers/server/zod4'
import { zodToConvex } from '../zod-convex'

// Recipes contain semantic definitions only. No source parser, constructor,
// parent, hooks or lazy caches survive registration.
type Recipe =
	| { readonly kind: 'value'; readonly value: unknown }
	| { readonly kind: 'array'; readonly items: readonly Recipe[] }
	| { readonly kind: 'record'; readonly entries: readonly (readonly [string, Recipe])[] }
	| { readonly kind: 'regexp'; readonly source: string; readonly flags: string }
	| {
			readonly kind: 'node'
			readonly constructor: string
			readonly definition: Recipe
			readonly id?: string
	  }

export interface DtoRecipe<Schema extends z.ZodType = z.ZodType> {
	readonly schemaType?: Schema
	readonly root: Recipe
}

type Node = z.core.$ZodType | z.core.$ZodCheck
const constructors = new Map<
	string,
	{
		matches(node: Node): boolean
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Only recipe-restored semantic definitions enter the selected installed constructor.
		create(definition: unknown): Node
	}
>()
const traitEntries: { readonly trait: string; readonly rank: number; readonly name: string }[] = []
// Base classes precede specialized classes so the most specific installed
// constructor wins. Never consult a caller's _zod.constr or constructor property.
register('object', z.ZodObject, 'ZodObject')
register('array', z.ZodArray, 'ZodArray')
register('optional', z.ZodOptional, 'ZodOptional')
register('exactOptional', z.ZodExactOptional, 'ZodExactOptional')
register('nullable', z.ZodNullable, 'ZodNullable')
register('nonoptional', z.ZodNonOptional, 'ZodNonOptional')
register('union', z.ZodUnion, 'ZodUnion')
register('discriminatedUnion', z.ZodDiscriminatedUnion, 'ZodDiscriminatedUnion')
register('tuple', z.ZodTuple, 'ZodTuple')
register('record', z.ZodRecord, 'ZodRecord')
register('string', z.ZodString, 'ZodString')
register('number', z.ZodNumber, 'ZodNumber')
register('boolean', z.ZodBoolean, 'ZodBoolean')
register('bigint', z.ZodBigInt, 'ZodBigInt')
register('null', z.ZodNull, 'ZodNull')
register('never', z.ZodNever, 'ZodNever')
register('literal', z.ZodLiteral, 'ZodLiteral')
register('enum', z.ZodEnum, 'ZodEnum')
register('custom', z.ZodCustom, 'ZodCustom')
register('minLength', z.core.$ZodCheckMinLength, '$ZodCheckMinLength')
register('maxLength', z.core.$ZodCheckMaxLength, '$ZodCheckMaxLength')
register('length', z.core.$ZodCheckLengthEquals, '$ZodCheckLengthEquals')
register('lessThan', z.core.$ZodCheckLessThan, '$ZodCheckLessThan')
register('greaterThan', z.core.$ZodCheckGreaterThan, '$ZodCheckGreaterThan')
register('multipleOf', z.core.$ZodCheckMultipleOf, '$ZodCheckMultipleOf')
register('checkNumberFormat', z.core.$ZodCheckNumberFormat, '$ZodCheckNumberFormat')
register('checkBigintFormat', z.core.$ZodCheckBigIntFormat, '$ZodCheckBigIntFormat')
register('stringFormat', z.core.$ZodCheckStringFormat, '$ZodCheckStringFormat')
register('regex', z.core.$ZodCheckRegex, '$ZodCheckRegex')
register('lowercase', z.core.$ZodCheckLowerCase, '$ZodCheckLowerCase')
register('uppercase', z.core.$ZodCheckUpperCase, '$ZodCheckUpperCase')
register('includes', z.core.$ZodCheckIncludes, '$ZodCheckIncludes')
register('startsWith', z.core.$ZodCheckStartsWith, '$ZodCheckStartsWith')
register('endsWith', z.core.$ZodCheckEndsWith, '$ZodCheckEndsWith')
register('property', z.core.$ZodCheckProperty, '$ZodCheckProperty')
register('properties', z.core.$ZodCheckProperties, '$ZodCheckProperties')
register('numberFormat', z.ZodNumberFormat, 'ZodNumberFormat')
register('bigintFormat', z.ZodBigIntFormat, 'ZodBigIntFormat')
// Format schemas are also checks; preserve their implicit checks, including
// URL/JWT validation which cannot be represented by a regex alone.
register('coreEmail', z.core.$ZodEmail, '$ZodEmail')
register('coreGUID', z.core.$ZodGUID, '$ZodGUID')
register('coreUUID', z.core.$ZodUUID, '$ZodUUID')
register('coreURL', z.core.$ZodURL, '$ZodURL')
register('coreEmoji', z.core.$ZodEmoji, '$ZodEmoji')
register('coreNanoID', z.core.$ZodNanoID, '$ZodNanoID')
register('coreCUID', z.core.$ZodCUID, '$ZodCUID')
register('coreCUID2', z.core.$ZodCUID2, '$ZodCUID2')
register('coreULID', z.core.$ZodULID, '$ZodULID')
register('coreXID', z.core.$ZodXID, '$ZodXID')
register('coreKSUID', z.core.$ZodKSUID, '$ZodKSUID')
register('coreIPv4', z.core.$ZodIPv4, '$ZodIPv4')
register('coreIPv6', z.core.$ZodIPv6, '$ZodIPv6')
register('coreMAC', z.core.$ZodMAC, '$ZodMAC')
register('coreCIDRv4', z.core.$ZodCIDRv4, '$ZodCIDRv4')
register('coreCIDRv6', z.core.$ZodCIDRv6, '$ZodCIDRv6')
register('coreBase64', z.core.$ZodBase64, '$ZodBase64')
register('coreBase64URL', z.core.$ZodBase64URL, '$ZodBase64URL')
register('coreE164', z.core.$ZodE164, '$ZodE164')
register('coreJWT', z.core.$ZodJWT, '$ZodJWT')
register('coreISODateTime', z.core.$ZodISODateTime, '$ZodISODateTime')
register('coreISODate', z.core.$ZodISODate, '$ZodISODate')
register('coreISOTime', z.core.$ZodISOTime, '$ZodISOTime')
register('coreISODuration', z.core.$ZodISODuration, '$ZodISODuration')
register('coreCreditCard', z.core.$ZodCreditCard, '$ZodCreditCard')
register('coreIBAN', z.core.$ZodIBAN, '$ZodIBAN')
register('coreCustomStringFormat', z.core.$ZodCustomStringFormat, '$ZodCustomStringFormat')
register('email', z.ZodEmail, 'ZodEmail')
register('guid', z.ZodGUID, 'ZodGUID')
register('uuid', z.ZodUUID, 'ZodUUID')
register('url', z.ZodURL, 'ZodURL')
register('emoji', z.ZodEmoji, 'ZodEmoji')
register('nanoid', z.ZodNanoID, 'ZodNanoID')
register('cuid', z.ZodCUID, 'ZodCUID')
register('cuid2', z.ZodCUID2, 'ZodCUID2')
register('ulid', z.ZodULID, 'ZodULID')
register('xid', z.ZodXID, 'ZodXID')
register('ksuid', z.ZodKSUID, 'ZodKSUID')
register('ipv4', z.ZodIPv4, 'ZodIPv4')
register('ipv6', z.ZodIPv6, 'ZodIPv6')
register('mac', z.ZodMAC, 'ZodMAC')
register('cidrv4', z.ZodCIDRv4, 'ZodCIDRv4')
register('cidrv6', z.ZodCIDRv6, 'ZodCIDRv6')
register('base64', z.ZodBase64, 'ZodBase64')
register('base64url', z.ZodBase64URL, 'ZodBase64URL')
register('e164', z.ZodE164, 'ZodE164')
register('jwt', z.ZodJWT, 'ZodJWT')
register('isoDateTime', z.ZodISODateTime, 'ZodISODateTime')
register('isoDate', z.ZodISODate, 'ZodISODate')
register('isoTime', z.ZodISOTime, 'ZodISOTime')
register('isoDuration', z.ZodISODuration, 'ZodISODuration')
register('creditCard', z.ZodCreditCard, 'ZodCreditCard')
register('iban', z.ZodIBAN, 'ZodIBAN')
register('customStringFormat', z.ZodCustomStringFormat, 'ZodCustomStringFormat')
const dispatch = [...constructors.entries()].reverse()
const traitDispatch = new Map(
	traitEntries.map(
		({ trait, rank, name }) =>
			[
				trait,
				Object.freeze({ rank, entry: Object.freeze([name, constructors.get(name)!] as const) }),
			] as const,
	),
)
// The audited installed 4.5.4/4.6.5 constructors use literal trait membership,
// with no Parent specialization. Unknown peer versions retain the original scan.
const ordinaryTraitDispatch = ['4.5.4', '4.6.5'].includes(
	`${z.core.version.major}.${z.core.version.minor}.${z.core.version.patch}`,
)
const intrinsicSetHas = Set.prototype.has
const intrinsicSetForEach = Set.prototype.forEach

export function captureDto<Schema extends z.ZodType>(schema: Schema): DtoRecipe<Schema> {
	const seen = new WeakMap<object, Recipe>()
	const active = new WeakSet<object>()
	let nodes = 0
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Recursively decode preflighted Zod definitions into owned recipes.
	function capture(value: unknown, depth: number): Recipe {
		if (value === null || Object(value) !== value || value instanceof Function)
			return Object.freeze({ kind: 'value', value })
		// SAFETY: the boxing equality above excludes primitives.
		const object = value as object
		if (active.has(object)) throw new Error('Unsupported cyclic DTO schema')
		const cached = seen.get(object)
		if (cached) return cached
		if (depth > 64 || ++nodes > 8192) throw new Error('DTO schema graph budget exceeded')
		active.add(object)
		let recipe: Recipe
		if (value instanceof RegExp) {
			recipe = { kind: 'regexp', source: value.source, flags: value.flags }
		} else if (value instanceof z.core.$ZodType || value instanceof z.core.$ZodCheck) {
			if (
				value instanceof z.core.$ZodCheck &&
				value._zod.def.check === 'custom' &&
				!(value instanceof z.ZodCustom)
			)
				throw new Error('Unsupported opaque DTO check/superRefine; use .refine() instead')
			const entry =
				ordinaryDispatch(value) ?? dispatch.find(([, constructor]) => constructor.matches(value))
			if (!entry) throw new Error('Unsupported DTO schema or check')
			let id: string | undefined
			if (value instanceof z.ZodCustom) {
				const native = nativeValidator(value)
				if (native.kind === 'id') id = native.tableName
			}
			const definition =
				value instanceof z.ZodObject
					? // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- The installed Zod object definition requires this exact property.
						{ ...value._zod.def, shape: value.shape }
					: value._zod.def
			recipe = {
				kind: 'node',
				constructor: entry[0],
				definition: capture(definition, depth + 1),
				id,
			}
		} else if (Array.isArray(value)) {
			recipe = {
				kind: 'array',
				items: Object.freeze(value.map((child) => capture(child, depth + 1))),
			}
		} else {
			if (Object.hasOwn(object, '_zod'))
				throw new Error('Unsupported opaque DTO check/superRefine; use .refine() instead')
			if (
				Object.getPrototypeOf(value) !== Object.prototype &&
				Object.getPrototypeOf(value) !== null
			)
				throw new Error('Unsupported DTO definition object')
			const entries: (readonly [string, Recipe])[] = []
			for (const key of Reflect.ownKeys(object)) {
				if (String(key) !== key) throw new Error('Unsupported DTO definition symbol')
				const descriptor = Object.getOwnPropertyDescriptor(object, key)!
				if (!('value' in descriptor)) throw new Error('Unsupported DTO schema accessor')
				entries.push(Object.freeze([key, capture(descriptor.value, depth + 1)]))
			}
			recipe = { kind: 'record', entries: Object.freeze(entries) }
		}
		active.delete(object)
		Object.freeze(recipe)
		seen.set(object, recipe)
		return recipe
	}
	return Object.freeze({ root: capture(schema, 0) })
}

// Factories share immutable instructions only. Every occurrence invokes its factory
// again, so shared recipe nodes never share mutable materialized definitions.
type Factory = () => unknown
const factories = new WeakMap<Recipe, Factory>()

export function materializeDto<Schema extends z.ZodType>(recipe: DtoRecipe<Schema>): Schema {
	const result = compile(recipe.root)()
	if (!(result instanceof z.ZodType)) throw new Error('Expected classic DTO schema')
	// SAFETY: the recipe preserves the captured schema constructor and definition.
	return result as Schema
}

/** Captured public boundary facts; these never require projection construction. */
export type DtoBoundary =
	| { readonly kind: 'object'; readonly keys: readonly string[] }
	| {
			readonly kind: 'variant'
			readonly discriminator: string
			readonly branches: Readonly<Record<string, readonly string[]>>
	  }

interface NativeRecipe {
	emit(): GenericValidator
	boundary?: DtoBoundary
	literal?: readonly (string | number | boolean | bigint | null)[]
	fields?: ReadonlyMap<string, NativeRecipe>
}

// Initialize the ordinary classic container configuration before recording change
// detectors. These descriptors do not attest pristine installed code (D1).
z.object({})
const admissionConfig = z.core.globalConfig
const admissionDescriptors = Object.getOwnPropertyDescriptors(admissionConfig)
const installedMemoizer = z.core.memoizer()
const memoizerDescriptors = Object.getOwnPropertyDescriptors(installedMemoizer)
interface NativeDefinitionKeyDictionary {
	readonly [constructor: string]: readonly string[]
}
const nativeDefinitionKeys: NativeDefinitionKeyDictionary = {
	string: ['coerce'],
	number: ['coerce'],
	boolean: ['coerce'],
	bigint: ['coerce'],
	null: [],
	never: [],
	literal: ['values'],
	object: ['shape', 'catchall'],
	array: ['element'],
	optional: ['innerType'],
	nullable: ['innerType'],
	union: ['options'],
	discriminatedUnion: ['options', 'discriminator', 'inclusive'],
	custom: ['check', 'fn', 'abort'],
}

/** Nonthrowing eligibility only; native factories run at the original conversion stage. */
export function classifyDto(recipe: DtoRecipe): NativeRecipe | undefined {
	try {
		if (!ordinaryConstructorEnvironment()) return undefined
	} catch {
		return undefined
	}
	const completed = new Map<Recipe, NativeRecipe | undefined>()
	function classify(node: Recipe | undefined): NativeRecipe | undefined {
		if (!node || node.kind !== 'node') return undefined
		if (completed.has(node)) return completed.get(node)
		const allowed = Object.hasOwn(nativeDefinitionKeys, node.constructor)
			? nativeDefinitionKeys[node.constructor]
			: undefined
		if (!allowed || node.definition.kind !== 'record') return undefined
		const def = new Map(node.definition.entries)
		if ([...def.keys()].some((key) => !['type', 'checks', ...allowed].includes(key)))
			return undefined
		if (
			recipeValue(def.get('type')) !==
			(node.constructor === 'discriminatedUnion' ? 'union' : node.constructor)
		)
			return undefined
		if (def.has('checks') && denseItems(def.get('checks'))?.length !== 0) return undefined
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- The recipe classifier is the semantic-value parser; primitive inspection preserves eligibility and fallback without invoking schemas or hooks.
		if (def.has('coerce') && typeof recipeValue(def.get('coerce')) !== 'boolean') return undefined
		let result: NativeRecipe | undefined
		switch (node.constructor) {
			case 'string':
				result = { emit: () => v.string() }
				break
			case 'number':
				result = { emit: () => v.number() }
				break
			case 'boolean':
				result = { emit: () => v.boolean() }
				break
			case 'bigint':
				result = { emit: () => v.int64() }
				break
			case 'null':
				result = { emit: () => v.null() }
				break
			case 'never':
				result = { emit: () => v.union() }
				break
			case 'custom': {
				const id = node.id
				if (
					// oxlint-disable-next-line anti-slop/no-runtime-typeof -- The recipe classifier is the semantic-value parser; primitive inspection preserves eligibility and fallback without invoking schemas or hooks.
					typeof id !== 'string' ||
					recipeValue(def.get('check')) !== 'custom' ||
					// oxlint-disable-next-line anti-slop/no-runtime-typeof -- The recipe classifier is the semantic-value parser; primitive inspection preserves eligibility and fallback without invoking schemas or hooks.
					typeof recipeValue(def.get('fn')) !== 'function' ||
					// oxlint-disable-next-line anti-slop/no-runtime-typeof -- The recipe classifier is the semantic-value parser; primitive inspection preserves eligibility and fallback without invoking schemas or hooks.
					(def.has('abort') && typeof recipeValue(def.get('abort')) !== 'boolean')
				)
					return undefined
				result = { emit: () => v.id(id) }
				break
			}
			case 'literal': {
				const items = denseItems(def.get('values'))
				if (!items) return undefined
				const values: (string | number | boolean | bigint | null)[] = []
				for (const item of items) {
					if (item.kind !== 'value') return undefined
					const value = item.value
					if (
						value !== null &&
						// oxlint-disable-next-line anti-slop/no-runtime-typeof -- The recipe classifier is the semantic-value parser; primitive inspection preserves eligibility and fallback without invoking schemas or hooks.
						typeof value !== 'string' &&
						// oxlint-disable-next-line anti-slop/no-runtime-typeof -- The recipe classifier is the semantic-value parser; primitive inspection preserves eligibility and fallback without invoking schemas or hooks.
						typeof value !== 'boolean' &&
						// oxlint-disable-next-line anti-slop/no-runtime-typeof -- The recipe classifier is the semantic-value parser; primitive inspection preserves eligibility and fallback without invoking schemas or hooks.
						typeof value !== 'bigint' &&
						// oxlint-disable-next-line anti-slop/no-runtime-typeof -- The recipe classifier is the semantic-value parser; primitive inspection preserves eligibility and fallback without invoking schemas or hooks.
						!(typeof value === 'number' && Number.isFinite(value))
					)
						return undefined
					values.push(value)
				}
				result = {
					literal: values,
					emit: () => {
						const validators = values.map((value) => (value === null ? v.null() : v.literal(value)))
						return validators.length === 1 ? validators[0] : v.union(...validators)
					},
				}
				break
			}
			case 'object': {
				const fieldDefinitions = def.get('shape')
				if (fieldDefinitions?.kind !== 'record') return undefined
				const fields = new Map<string, NativeRecipe>()
				for (const [key, value] of fieldDefinitions.entries) {
					const child = classify(value)
					if (!child) return undefined
					fields.set(key, child)
				}
				const catchall = def.get('catchall')
				if (
					catchall &&
					!(catchall.kind === 'value' && catchall.value === undefined) &&
					!classify(catchall)
				)
					return undefined
				result = {
					fields,
					boundary: { kind: 'object', keys: [...fields.keys()] },
					emit: () =>
						v.object(Object.fromEntries([...fields].map(([key, child]) => [key, child.emit()]))),
				}
				break
			}
			case 'array':
			case 'optional':
			case 'nullable': {
				const child = classify(def.get(node.constructor === 'array' ? 'element' : 'innerType'))
				if (!child) return undefined
				const tag = node.constructor
				result = {
					emit: () => {
						const native = child.emit()
						if (tag === 'optional') return v.optional(native)
						if (tag === 'nullable')
							return native.isOptional === 'optional'
								? v.optional(v.union(vRequired(native), v.null()))
								: v.union(native, v.null())
						if (native.isOptional === 'optional')
							throw new Error('Arrays of optional values are not supported')
						return v.array(native)
					},
				}
				break
			}
			case 'union':
			case 'discriminatedUnion': {
				const items = denseItems(def.get('options'))
				if (!items) return undefined
				const children: NativeRecipe[] = []
				for (const item of items) {
					const child = classify(item)
					if (!child) return undefined
					children.push(child)
				}
				let boundary: DtoBoundary | undefined
				if (node.constructor === 'discriminatedUnion') {
					const discriminator = recipeValue(def.get('discriminator'))
					if (
						// oxlint-disable-next-line anti-slop/no-runtime-typeof -- The recipe classifier is the semantic-value parser; primitive inspection preserves eligibility and fallback without invoking schemas or hooks.
						typeof discriminator !== 'string' ||
						!children.length ||
						(def.has('inclusive') && recipeValue(def.get('inclusive')) !== false)
					)
						return undefined
					const branches: Record<string, readonly string[]> = Object.create(null)
					for (const child of children) {
						const tag = child.fields?.get(discriminator)?.literal
						if (
							child.boundary?.kind !== 'object' ||
							tag?.length !== 1 ||
							// oxlint-disable-next-line anti-slop/no-runtime-typeof -- The recipe classifier is the semantic-value parser; primitive inspection preserves eligibility and fallback without invoking schemas or hooks.
							typeof tag[0] !== 'string' ||
							Object.hasOwn(branches, tag[0])
						)
							return undefined
						branches[tag[0]] = child.boundary.keys
					}
					boundary = { kind: 'variant', discriminator, branches }
				}
				result = { boundary, emit: () => v.union(...children.map((child) => child.emit())) }
				break
			}
		}
		completed.set(node, result)
		return result
	}
	return classify(recipe.root)
}

function ordinaryDispatch(value: Node): Readonly<(typeof dispatch)[number]> | undefined {
	if (!ordinaryTraitDispatch) return
	try {
		const internal = Object.getOwnPropertyDescriptor(value, '_zod')
		if (
			!internal ||
			!('value' in internal) ||
			internal.value === null ||
			// oxlint-disable-next-line anti-slop/no-runtime-typeof -- The low-level trait guard inspects descriptor values without invoking caller getters or parsers; ineligible values retain the installed membership scan.
			typeof internal.value !== 'object'
		)
			return
		const descriptor = Object.getOwnPropertyDescriptor(internal.value, 'traits')
		if (!descriptor || !('value' in descriptor)) return
		const traits: unknown = descriptor.value
		if (
			traits === null ||
			// oxlint-disable-next-line anti-slop/no-runtime-typeof -- The low-level trait guard inspects descriptor values without invoking caller getters or parsers; ineligible values retain the installed membership scan.
			typeof traits !== 'object' ||
			Object.getPrototypeOf(traits) !== Set.prototype ||
			Object.getOwnPropertyDescriptor(traits, 'has')
		)
			return
		const has = Object.getOwnPropertyDescriptor(Set.prototype, 'has')
		if (!has || !('value' in has) || has.value !== intrinsicSetHas) return
		// Intrinsic brand check rejects lookalikes/Proxy-wrapped Sets without readers.
		intrinsicSetHas.call(traits, '')
		let selected: Readonly<(typeof dispatch)[number]> | undefined
		let rank = -1
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Intrinsic Set iteration supplies arbitrary members; the adjacent primitive guard admits only literal trait names without invoking caller code.
		intrinsicSetForEach.call(traits, (trait: unknown) => {
			// oxlint-disable-next-line anti-slop/no-runtime-typeof -- The low-level trait guard inspects descriptor values without invoking caller getters or parsers; ineligible values retain the installed membership scan.
			if (typeof trait !== 'string') return
			const entry = traitDispatch.get(trait)
			if (entry && entry.rank > rank) {
				rank = entry.rank
				selected = entry.entry
			}
		})
		return selected
	} catch {
		// Unsafe eligibility retains the original installed membership scan.
		return
	}
}

function compile(recipe: Recipe): Factory {
	const cached = factories.get(recipe)
	if (cached) return cached
	let factory: Factory
	switch (recipe.kind) {
		case 'value':
			factory = () => recipe.value
			break
		case 'regexp':
			factory = () => new RegExp(recipe.source, recipe.flags)
			break
		case 'array': {
			const items = recipe.items.map(compile)
			factory = () => items.map((item) => item())
			break
		}
		case 'record': {
			const entries = recipe.entries.map(([key, child]) => [key, compile(child)] as const)
			factory = () => Object.fromEntries(entries.map(([key, child]) => [key, child()]))
			break
		}
		case 'node': {
			const definition = compile(recipe.definition)
			if (recipe.id !== undefined) {
				const id = recipe.id
				factory = () => {
					const restored = definition()
					const result = zid(id)
					// The new zid is registered with convex-helpers. Added refinements are
					// reconstructed independently, never inherited via _zod.parent.
					if (restored instanceof Object && 'checks' in restored) {
						const checks = restored.checks
						if (Array.isArray(checks)) return result.check(...checks)
					}
					return result
				}
			} else {
				const constructor = constructors.get(recipe.constructor)!
				factory = () => constructor.create(definition())
			}
			break
		}
	}
	factories.set(recipe, factory)
	return factory
}

function nativeValidator(schema: z.ZodType): GenericValidator {
	return zodToConvex(schema)
}

function register<T extends Node>(
	name: string,
	Constructor: z.core.$constructor<T> | undefined,
	trait: string,
): void {
	if (Constructor === undefined) return
	traitEntries.push(Object.freeze({ trait, rank: constructors.size, name }))
	constructors.set(name, {
		matches: (node) => node instanceof Constructor,
		create: (definition) => {
			// SAFETY: capture selected this installed constructor and recursively copied
			// its own semantic definition; materialization restores every child first.
			return new Constructor(definition as T['_zod']['def'])
		},
	})
}

function sameDescriptors(
	// oxlint-disable-next-line anti-slop/no-object-parameters -- Descriptor comparison accepts the installed config or memoizer object itself; parsing would change the observed identity and descriptors.
	object: object,
	before: PropertyDescriptorMap,
	ignored: readonly string[] = [],
): boolean {
	const after = Object.getOwnPropertyDescriptors(object)
	const keys = new Set([...Object.keys(before), ...Object.keys(after)])
	for (const key of keys) {
		if (ignored.includes(key)) continue
		const a = before[key],
			b = after[key]
		if (!a || !b) {
			const present = a ?? b
			if (present && 'value' in present && present.value === undefined) continue
			return false
		}
		if (
			!('value' in a) ||
			!('value' in b) ||
			!Object.is(a.value, b.value) ||
			a.writable !== b.writable ||
			a.configurable !== b.configurable ||
			a.enumerable !== b.enumerable
		)
			return false
	}
	return true
}
function ordinaryConstructorEnvironment(): boolean {
	const version: { major: number; minor: number; patch: number } = z.core.version
	if (
		version.major !== 4 ||
		!((version.minor === 6 && version.patch === 5) || (version.minor === 5 && version.patch === 4))
	)
		return false
	const global = Object.getOwnPropertyDescriptor(globalThis, '__zod_globalConfig')
	if (!global || !('value' in global) || global.value !== admissionConfig) return false
	const hook = Object.getOwnPropertyDescriptor(admissionConfig, 'postProcessor')
	if (hook && (!('value' in hook) || hook.value !== undefined)) return false
	const memo = Object.getOwnPropertyDescriptor(admissionConfig, 'memoizer')
	return (
		!!memo &&
		'value' in memo &&
		memo.value === installedMemoizer &&
		sameDescriptors(admissionConfig, admissionDescriptors, ['postProcessor']) &&
		sameDescriptors(installedMemoizer, memoizerDescriptors)
	)
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- This recipe-parser accessor intentionally returns an unparsed semantic leaf; each classifier branch checks its required primitive contract before use.
function recipeValue(recipe: Recipe | undefined): unknown {
	return recipe?.kind === 'value' ? recipe.value : undefined
}
function denseItems(recipe: Recipe | undefined): readonly Recipe[] | undefined {
	if (recipe?.kind !== 'array') return undefined
	for (let i = 0; i < recipe.items.length; i++)
		if (!Object.hasOwn(recipe.items, i)) return undefined
	return recipe.items
}
