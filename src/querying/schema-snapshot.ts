import { z } from 'zod'
import type { GenericValidator } from 'convex/values'
import { zid, zodToConvex } from 'convex-helpers/server/zod4'

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
// Base classes precede specialized classes so the most specific installed
// constructor wins. Never consult a caller's _zod.constr or constructor property.
register('object', z.ZodObject)
register('array', z.ZodArray)
register('optional', z.ZodOptional)
register('exactOptional', z.ZodExactOptional)
register('nullable', z.ZodNullable)
register('nonoptional', z.ZodNonOptional)
register('union', z.ZodUnion)
register('discriminatedUnion', z.ZodDiscriminatedUnion)
register('tuple', z.ZodTuple)
register('record', z.ZodRecord)
register('string', z.ZodString)
register('number', z.ZodNumber)
register('boolean', z.ZodBoolean)
register('bigint', z.ZodBigInt)
register('null', z.ZodNull)
register('never', z.ZodNever)
register('literal', z.ZodLiteral)
register('enum', z.ZodEnum)
register('custom', z.ZodCustom)
register('minLength', z.core.$ZodCheckMinLength)
register('maxLength', z.core.$ZodCheckMaxLength)
register('length', z.core.$ZodCheckLengthEquals)
register('lessThan', z.core.$ZodCheckLessThan)
register('greaterThan', z.core.$ZodCheckGreaterThan)
register('multipleOf', z.core.$ZodCheckMultipleOf)
register('checkNumberFormat', z.core.$ZodCheckNumberFormat)
register('checkBigintFormat', z.core.$ZodCheckBigIntFormat)
register('stringFormat', z.core.$ZodCheckStringFormat)
register('regex', z.core.$ZodCheckRegex)
register('lowercase', z.core.$ZodCheckLowerCase)
register('uppercase', z.core.$ZodCheckUpperCase)
register('includes', z.core.$ZodCheckIncludes)
register('startsWith', z.core.$ZodCheckStartsWith)
register('endsWith', z.core.$ZodCheckEndsWith)
register('property', z.core.$ZodCheckProperty)
register('properties', z.core.$ZodCheckProperties)
register('numberFormat', z.ZodNumberFormat)
register('bigintFormat', z.ZodBigIntFormat)
// Format schemas are also checks; preserve their implicit checks, including
// URL/JWT validation which cannot be represented by a regex alone.
register('coreEmail', z.core.$ZodEmail)
register('coreGUID', z.core.$ZodGUID)
register('coreUUID', z.core.$ZodUUID)
register('coreURL', z.core.$ZodURL)
register('coreEmoji', z.core.$ZodEmoji)
register('coreNanoID', z.core.$ZodNanoID)
register('coreCUID', z.core.$ZodCUID)
register('coreCUID2', z.core.$ZodCUID2)
register('coreULID', z.core.$ZodULID)
register('coreXID', z.core.$ZodXID)
register('coreKSUID', z.core.$ZodKSUID)
register('coreIPv4', z.core.$ZodIPv4)
register('coreIPv6', z.core.$ZodIPv6)
register('coreMAC', z.core.$ZodMAC)
register('coreCIDRv4', z.core.$ZodCIDRv4)
register('coreCIDRv6', z.core.$ZodCIDRv6)
register('coreBase64', z.core.$ZodBase64)
register('coreBase64URL', z.core.$ZodBase64URL)
register('coreE164', z.core.$ZodE164)
register('coreJWT', z.core.$ZodJWT)
register('coreISODateTime', z.core.$ZodISODateTime)
register('coreISODate', z.core.$ZodISODate)
register('coreISOTime', z.core.$ZodISOTime)
register('coreISODuration', z.core.$ZodISODuration)
register('coreCreditCard', z.core.$ZodCreditCard)
register('coreIBAN', z.core.$ZodIBAN)
register('coreCustomStringFormat', z.core.$ZodCustomStringFormat)
register('email', z.ZodEmail)
register('guid', z.ZodGUID)
register('uuid', z.ZodUUID)
register('url', z.ZodURL)
register('emoji', z.ZodEmoji)
register('nanoid', z.ZodNanoID)
register('cuid', z.ZodCUID)
register('cuid2', z.ZodCUID2)
register('ulid', z.ZodULID)
register('xid', z.ZodXID)
register('ksuid', z.ZodKSUID)
register('ipv4', z.ZodIPv4)
register('ipv6', z.ZodIPv6)
register('mac', z.ZodMAC)
register('cidrv4', z.ZodCIDRv4)
register('cidrv6', z.ZodCIDRv6)
register('base64', z.ZodBase64)
register('base64url', z.ZodBase64URL)
register('e164', z.ZodE164)
register('jwt', z.ZodJWT)
register('isoDateTime', z.ZodISODateTime)
register('isoDate', z.ZodISODate)
register('isoTime', z.ZodISOTime)
register('isoDuration', z.ZodISODuration)
register('creditCard', z.ZodCreditCard)
register('iban', z.ZodIBAN)
register('customStringFormat', z.ZodCustomStringFormat)
const dispatch = [...constructors.entries()].reverse()

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
			const entry = dispatch.find(([, constructor]) => constructor.matches(value))
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

export function materializeDto<Schema extends z.ZodType>(recipe: DtoRecipe<Schema>): Schema {
	// oxlint-disable-next-line anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- A recursive recipe restores heterogeneous constructor definitions, never external input.
	function restore(recipe: Recipe): unknown {
		switch (recipe.kind) {
			case 'value':
				return recipe.value
			case 'regexp':
				// oxlint-disable-next-line anti-slop/no-known-value-widening -- RegExp is one of the heterogeneous recipe result types.
				return new RegExp(recipe.source, recipe.flags)
			case 'array':
				return recipe.items.map(restore)
			case 'record':
				return Object.fromEntries(recipe.entries.map(([key, child]) => [key, restore(child)]))
			case 'node': {
				const definition = restore(recipe.definition)
				if (recipe.id !== undefined) {
					const result = zid(recipe.id)
					// The new zid is registered with convex-helpers. Added refinements are
					// reconstructed independently, never inherited via _zod.parent.
					if (definition instanceof Object && 'checks' in definition) {
						const checks = definition.checks
						if (Array.isArray(checks)) return result.check(...checks)
					}
					return result
				}
				return constructors.get(recipe.constructor)!.create(definition)
			}
		}
	}
	const result = restore(recipe.root)
	if (!(result instanceof z.ZodType)) throw new Error('Expected classic DTO schema')
	// SAFETY: the recipe preserves the captured schema constructor and definition.
	return result as Schema
}

function nativeValidator(schema: z.ZodType): GenericValidator {
	return zodToConvex(schema)
}

function register<T extends Node>(
	name: string,
	Constructor: z.core.$constructor<T> | undefined,
): void {
	if (Constructor === undefined) return
	constructors.set(name, {
		matches: (node) => node instanceof Constructor,
		create: (definition) => {
			// SAFETY: capture selected this installed constructor and recursively copied
			// its own semantic definition; materialization restores every child first.
			return new Constructor(definition as T['_zod']['def'])
		},
	})
}
