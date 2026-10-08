/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-type-aliases, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- Selected native transport boundaries validate opaque identities and converter JSON without decoding domain inputs. */
import { ConvexError } from 'convex/values'
import type { ContractInput, ContractOutput, ContractSchema } from './contract'
import type { DecodedFailure, ErrorContract, ErrorDefinitions, UnknownFailure } from './errors'

declare const selectedTypes: unique symbol
declare const executorTypes: unique symbol

type Definition = {
	input: ContractSchema
	result: ContractSchema
	wire?: { schema: ContractSchema }
}
export type OperationPublicResult<D extends Definition> = D extends {
	wire: { schema: infer Schema extends ContractSchema }
}
	? ContractInput<Schema>
	: ContractOutput<D['result']>

/** Only the selected input/public contracts are exposed, never handlers or other operations. */
export type SelectedOperation<
	Owner extends symbol,
	Key extends string,
	Input extends ContractSchema,
	Public,
> = Readonly<{
	owner: Owner
	key: Key
	kind: 'mutation' | 'query'
	input: Input
	result: ContractSchema
	readonly [selectedTypes]: { readonly input: ContractInput<Input>; readonly public: Public }
}>
type Selection = Readonly<{
	owner: symbol
	key: string
	kind: 'mutation' | 'query'
	input: ContractSchema
	result: ContractSchema
	readonly [selectedTypes]: { readonly input: unknown; readonly public: unknown }
}>
type InputOf<S extends Selection> = S[typeof selectedTypes]['input']
type PublicOf<S extends Selection> = S[typeof selectedTypes]['public']

const selections = new WeakSet<object>()
const executors = new WeakMap<
	object,
	{
		selection: Selection
		// oxlint-disable-next-line anti-slop/no-unknown-returns -- Private heterogeneous storage erases public result types; selected identity checks recover the exact raw/public pair at invocation.
		execute: (input: never) => Promise<unknown>
	}
>()

/** Registry integrators must check membership before selecting their own definition. */
export function selectOperation<
	const Owner extends symbol,
	const Key extends string,
	const D extends Definition,
>(
	owner: Owner,
	kind: 'mutation' | 'query',
	key: Key,
	definition: D,
): SelectedOperation<Owner, Key, D['input'], OperationPublicResult<D>> {
	if (
		typeof owner !== 'symbol' ||
		!key ||
		(kind !== 'mutation' && kind !== 'query') ||
		!definition?.input ||
		!definition.result
	) {
		throw Error('Invalid selected operation')
	}
	// SAFETY: private identity records this exact paired schema; its type-only slots are never read at runtime.
	const selected = Object.freeze({
		owner,
		key,
		kind,
		input: definition.input,
		result: definition.wire?.schema ?? definition.result,
	}) as SelectedOperation<Owner, Key, D['input'], OperationPublicResult<D>>
	selections.add(selected)
	return selected
}

export type OperationExecutor<S extends Selection> = Readonly<{
	owner: S['owner']
	key: S['key']
	readonly [executorTypes]: S
}>

/** The host captures authority in an already authorized native Promise call. */
export function bindOperationExecutor<const S extends Selection>(
	selected: S,
	configuration: {
		owner: NoInfer<S['owner']>
		key: NoInfer<S['key']>
		execute: (raw: NoInfer<InputOf<S>>) => Promise<NoInfer<PublicOf<S>>>
	},
): OperationExecutor<S> {
	if (
		!selections.has(selected) ||
		configuration.owner !== selected.owner ||
		configuration.key !== selected.key ||
		typeof configuration.execute !== 'function'
	) {
		throw Error('Executor does not own the selected operation')
	}
	// SAFETY: the private map restores the concrete selected raw/public pair only after identity checks.
	const executor = Object.freeze({
		owner: selected.owner,
		key: selected.key,
	}) as OperationExecutor<S>
	executors.set(executor, {
		selection: selected,
		execute: configuration.execute,
	})
	return executor
}

export const operationToolDialect = 'https://json-schema.org/draft/2020-12/schema' as const
type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }
export type OperationToolJsonSchema = Readonly<{ [keyword: string]: Json }>
export type OperationToolConverter<Input extends ContractSchema = ContractSchema> = Readonly<{
	dialect: typeof operationToolDialect
	/** Represent raw transport input. Unsupported IDs/transforms must throw, never be approximated. */
	convert: (input: Input) => OperationToolJsonSchema
}>
export type OperationToolDefinition<
	S extends Selection = Selection,
	Errors extends ErrorDefinitions = ErrorDefinitions,
> = Readonly<{
	operation: S
	executor: OperationExecutor<S>
	description: string
	converter: OperationToolConverter<S['input']>
	errors?: Pick<ErrorContract<Errors>, 'decode'>
}>
type ToolConstraint = Readonly<{
	operation: Selection
	executor: OperationExecutor<Selection>
	description: string
	converter: {
		dialect: typeof operationToolDialect
		convert: (input: never) => OperationToolJsonSchema
	}
	errors?: Pick<ErrorContract<ErrorDefinitions>, 'decode'>
}>
type Checked<T extends ToolConstraint> = T & OperationToolDefinition<T['operation']>
type FailureOf<T> = T extends { errors: Pick<ErrorContract<infer E>, 'decode'> }
	? DecodedFailure<E>
	: UnknownFailure
export type OperationToolOutcome<Public, Failure = UnknownFailure> =
	| Readonly<{ _tag: 'Success'; value: Public }>
	| Failure
export type OperationTool<T extends ToolConstraint> = Readonly<{
	name: string
	description: string
	args: OperationToolJsonSchema
	invoke: (
		raw: InputOf<T['operation']>,
	) => Promise<OperationToolOutcome<PublicOf<T['operation']>, FailureOf<T>>>
}>

export function createOperationTools<const T extends Readonly<Record<string, ToolConstraint>>>(
	definitions: T & { [K in keyof T]: Checked<T[K]> },
): Readonly<{ [K in keyof T]: OperationTool<T[K]> }>
export function createOperationTools<
	const T extends readonly (ToolConstraint & { name: string })[],
>(
	definitions: T & { [K in keyof T]: Checked<T[K]> },
): Readonly<{ [D in T[number] as D['name']]: OperationTool<D> }>
export function createOperationTools(
	definitions:
		| Readonly<Record<string, ToolConstraint>>
		| readonly (ToolConstraint & { name: string })[],
): Readonly<Record<string, OperationTool<ToolConstraint>>> {
	const entries = Array.isArray(definitions)
		? definitions.map((definition) => [definition.name, definition] as const)
		: Object.entries(definitions)
	const tools: Record<string, OperationTool<ToolConstraint>> = Object.create(null)
	for (const [name, definition] of entries) {
		if (!name || Object.hasOwn(tools, name)) throw Error('Duplicate or empty operation tool name')
		const paired = definition.executor && executors.get(definition.executor)
		if (
			!selections.has(definition.operation) ||
			!paired ||
			paired.selection !== definition.operation
		)
			throw Error('Tool requires its selected operation executor')
		if (
			!definition.description ||
			definition.converter?.dialect !== operationToolDialect ||
			typeof definition.converter.convert !== 'function'
		)
			throw Error('Unsupported operation tool converter')
		// Conversion never executes the input decoder, and invocation never executes conversion.
		// SAFETY: the checked tool overload pairs the converter with this selected input schema; the never cast bridges heterogeneous iteration without changing the schema.
		const args = schemaSnapshot(definition.converter.convert(definition.operation.input as never))
		const errors = definition.errors
		tools[name] = Object.freeze({
			name,
			description: definition.description,
			args,
			async invoke(raw: unknown) {
				try {
					// SAFETY: binding owns this raw/public pair and its native boundary performs decoding/policy/projection.
					return { _tag: 'Success' as const, value: await paired.execute(raw as never) }
				} catch (error) {
					// This catch runs only after the native call rejects. Native mutations retain rollback semantics.
					try {
						if (error instanceof ConvexError && errors) return errors.decode(error.data)
					} catch {
						/* Invalid host error decoders cannot publish diagnostics. */
					}
					return { _tag: 'UnknownFailure' as const, version: 1 as const }
				}
			},
		})
	}
	return Object.freeze(tools)
}

const schemaKeywords = new Set([
	'properties',
	'$defs',
	'items',
	'additionalProperties',
	'anyOf',
	'oneOf',
	'allOf',
	'not',
	'required',
	'enum',
	'const',
	'default',
	'examples',
])
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const textKeywords = new Set([
	'title',
	'description',
	'format',
	'pattern',
	'$ref',
	'$id',
	'x-convex-table',
])
const countKeywords = new Set([
	'minLength',
	'maxLength',
	'minItems',
	'maxItems',
	'minProperties',
	'maxProperties',
])
const numberKeywords = new Set([
	'minimum',
	'maximum',
	'exclusiveMinimum',
	'exclusiveMaximum',
	'multipleOf',
])
const scalarKeywords = new Set([
	...textKeywords,
	...countKeywords,
	...numberKeywords,
	'type',
	'uniqueItems',
	'$schema',
])

function schemaSnapshot(value: OperationToolJsonSchema): OperationToolJsonSchema {
	const seen = new Set<object>()
	function copy(value: Json): Json {
		if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
		if (typeof value === 'number' && Number.isFinite(value)) return value
		if (typeof value !== 'object' || seen.has(value))
			throw Error('Converter schema must be JSON safe')
		seen.add(value)
		try {
			if (Array.isArray(value)) return Object.freeze(value.map(copy))
			if (!isRecord(value)) throw Error('Converter schema must be a plain JSON object')
			return Object.freeze(
				Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])),
			)
		} finally {
			seen.delete(value)
		}
	}
	function check(schema: Json): void {
		if (typeof schema === 'boolean') return
		if (!isRecord(schema)) throw Error('Unsupported JSON Schema shape')
		for (const [key, child] of Object.entries(schema)) {
			if (!scalarKeywords.has(key) && !schemaKeywords.has(key))
				throw Error('Unsupported JSON Schema keyword')
			if (textKeywords.has(key) && typeof child !== 'string')
				throw Error('Invalid JSON Schema text keyword')
			if (
				countKeywords.has(key) &&
				(typeof child !== 'number' || !Number.isInteger(child) || child < 0)
			)
				throw Error('Invalid JSON Schema count keyword')
			if (
				numberKeywords.has(key) &&
				(typeof child !== 'number' ||
					!Number.isFinite(child) ||
					(key === 'multipleOf' && child <= 0))
			)
				throw Error('Invalid JSON Schema number keyword')
			if (key === 'uniqueItems' && typeof child !== 'boolean')
				throw Error('Invalid JSON Schema boolean keyword')
			if (key === 'pattern') {
				try {
					// SAFETY: pattern belongs to textKeywords and passed the string check above; this validates syntax without matching input.
					new RegExp(child as string)
				} catch {
					throw Error('Invalid JSON Schema pattern')
				}
			}
			if ((key === 'enum' || key === 'examples') && !Array.isArray(child))
				throw Error('Invalid JSON Schema array keyword')
			if (key === 'enum' && Array.isArray(child) && !child.length)
				throw Error('Invalid JSON Schema enum')
			if (key === '$schema' && child !== operationToolDialect)
				throw Error('Unsupported JSON Schema dialect')
			if (
				key === 'type' &&
				!(typeof child === 'string' && types.has(child)) &&
				!(
					Array.isArray(child) &&
					child.length > 0 &&
					child.every((type) => typeof type === 'string' && types.has(type))
				)
			)
				throw Error('Unsupported JSON Schema type')
			if (key === 'properties' || key === '$defs') {
				if (!isRecord(child)) throw Error('Unsupported JSON Schema properties')
				Object.values(child).forEach(check)
			} else if (key === 'items' || key === 'not' || key === 'additionalProperties') check(child)
			else if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
				if (!Array.isArray(child) || !child.length)
					throw Error('Unsupported JSON Schema alternatives')
				child.forEach(check)
			} else if (
				key === 'required' &&
				(!Array.isArray(child) ||
					child.some((field) => typeof field !== 'string') ||
					new Set(child).size !== child.length)
			)
				throw Error('Unsupported JSON Schema required fields')
		}
	}
	const snapshot = copy(value)
	if (!isRecord(snapshot) || snapshot.type !== 'object')
		throw Error('Operation tool arguments require an object JSON Schema')
	check(snapshot)
	return snapshot
}
function isRecord(value: Json): value is { readonly [key: string]: Json } {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}
