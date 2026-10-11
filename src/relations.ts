import { z } from 'zod'
import { zodToConvex, type ConvexValidatorFromZod } from 'convex-helpers/server/zod4'
import type { TableDefinition, PaginationResult } from 'convex/server'
import {
	v,
	type GenericId,
	type GenericValidator,
	type ValidatorJSON,
	type JSONValue,
} from 'convex/values'
import { paginated } from './zod-table'
import {
	nativePagination,
	relationFilterSchema,
	scalarPredicateSchema,
	type FieldSchemas,
	type FilterGrammar,
	type PaginationOptionsSchema,
	type ScalarSelection,
	type ScalarPredicate,
} from './querying/filters'

/** Object table boundaries only. Runtime metadata comes from native validators/export. */
export interface RelationTable {
	tableName: string
	schema: z.ZodObject
	publicDto: z.ZodObject
	table: TableDefinition
	dto(includeId: true): z.ZodType
}
export type RelationTables = Record<string, RelationTable>
/** Internal named declaration dependency; excluded from the supported relations facade. */
export interface SelectionMask {
	[key: string]: true | SelectionMask
}
type Fields<T extends RelationTable> = T['schema']['shape']
type Native<T extends RelationTable, K extends keyof Fields<T>> = ConvexValidatorFromZod<
	Fields<T>[K],
	'required'
>['type']
const fieldBrand: unique symbol = Symbol('relationField')
const edgeBrand: unique symbol = Symbol('relationEdge')
type Comparable<Value> = Exclude<Value, null | undefined>
type Same<A, B> = [Comparable<A> | Comparable<B>] extends [never]
	? false
	: [Comparable<A>] extends [Comparable<B>]
		? [Comparable<B>] extends [Comparable<A>]
			? true
			: false
		: false

export interface FieldReference<Table extends string, Field extends string, Value> {
	readonly [fieldBrand]: Value
	readonly table: Table
	readonly field: Field
	through<J extends AnyField>(
		junction: J & (Same<Value, J[typeof fieldBrand]> extends true ? {} : never),
	): ThroughReference<Table, Field, Value, J>
}
type AnyField = FieldReference<string, string, any>
export interface ThroughReference<
	Table extends string,
	Field extends string,
	Value,
	Junction extends AnyField,
> {
	readonly base: FieldReference<Table, Field, Value>
	readonly junction: Junction
}
type AnyThrough = ThroughReference<string, string, any, AnyField>
type Leg = AnyField | AnyThrough
type Base<L extends Leg> = L extends AnyThrough ? L['base'] : L
type JunctionTable<L extends Leg> = L extends AnyThrough ? L['junction']['table'] : never
type CompatibleLegs<F extends Leg, T extends Leg> = F extends AnyThrough
	? T extends AnyThrough
		? Same<JunctionTable<F>, JunctionTable<T>> extends true
			? {}
			: never
		: never
	: T extends AnyThrough
		? never
		: Same<Base<F>[typeof fieldBrand], Base<T>[typeof fieldBrand]> extends true
			? {}
			: never

export interface RelationEdge<
	Source extends string,
	Target extends string,
	Cardinality extends 'one' | 'many',
> {
	readonly [edgeBrand]: true
	readonly source: Source
	readonly target: Target
	readonly cardinality: Cardinality
	readonly from: Leg
	readonly to: Leg
}
type AnyEdge = RelationEdge<string, string, 'one' | 'many'>
type FieldReferences<Tables extends RelationTables> = {
	[T in keyof Tables]: {
		[K in Extract<keyof Fields<Tables[T]>, string>]: FieldReference<
			Extract<T, string>,
			K,
			Native<Tables[T], K>
		>
	}
}
type AllReferences<Tables extends RelationTables> = {
	[T in keyof Tables]: FieldReferences<Tables>[T][Extract<keyof FieldReferences<Tables>[T], string>]
}[keyof Tables]
type Builders<Tables extends RelationTables, C extends 'one' | 'many'> = {
	[T in keyof Tables]: <
		F extends AllReferences<Tables> | AnyThrough,
		To extends
			| FieldReferences<Tables>[T][Extract<keyof FieldReferences<Tables>[T], string>]
			| AnyThrough,
	>(
		spec: { from: F; to: To } & CompatibleLegs<F, To> & (Base<To>['table'] extends T ? {} : never),
	) => RelationEdge<Base<F>['table'], Extract<T, string>, C>
}
export type RelationBuilder<Tables extends RelationTables> = FieldReferences<Tables> & {
	one: Builders<Tables, 'one'>
	many: Builders<Tables, 'many'>
}
export type RelationDeclarations = Record<string, Record<string, AnyEdge>>
type ExactDeclarations<Tables extends RelationTables, D extends RelationDeclarations> = {
	[T in keyof D]: T extends keyof Tables
		? {
				[K in keyof D[T]]: K extends
					| keyof Fields<Tables[T]>
					| 'and'
					| 'or'
					| 'not'
					| 'fields'
					| 'then'
					| '__proto__'
					| 'constructor'
					| 'prototype'
					? never
					: D[T][K]['source'] extends T
						? D[T][K]
						: never
			}
		: never
}
type Depth = readonly [1, 1, 1, 1]
type Tail<D extends readonly 1[]> = D extends readonly [1, ...infer R extends 1[]] ? R : []
type Edges<D, T> = T extends keyof D ? D[T] : {}
type Target<E> = E extends AnyEdge ? E['target'] : never
export type RelationSelection<
	Tables extends RelationTables,
	D extends RelationDeclarations,
	T extends keyof Tables,
	Level extends readonly 1[] = Depth,
> = Level extends readonly []
	? Record<string, never>
	: {
			[K in keyof Edges<D, T>]?:
				| true
				| RelationSelection<Tables, D, Extract<Target<Edges<D, T>[K]>, keyof Tables>, Tail<Level>>
		}
export type RelationFilterSelection<
	Tables extends RelationTables,
	D extends RelationDeclarations,
	T extends keyof Tables,
	Level extends readonly 1[] = Depth,
> = ScalarSelection<Fields<Tables[T]>> &
	(Level extends readonly []
		? {}
		: {
				[K in keyof Edges<D, T>]?: RelationFilterSelection<
					Tables,
					D,
					Extract<Target<Edges<D, T>[K]>, keyof Tables>,
					Tail<Level>
				>
			})
type ExactOutputMask<
	Tables extends RelationTables,
	D extends RelationDeclarations,
	T extends keyof Tables,
	S,
	L extends readonly 1[] = Depth,
> = S & {
	[K in keyof S]: L extends readonly []
		? never
		: K extends keyof Edges<D, T>
			? S[K] extends true
				? true
				: ExactOutputMask<Tables, D, Extract<Target<Edges<D, T>[K]>, keyof Tables>, S[K], Tail<L>>
			: never
}
type ExactFilterMask<
	Tables extends RelationTables,
	D extends RelationDeclarations,
	T extends keyof Tables,
	S,
	L extends readonly 1[] = Depth,
> = S & {
	[K in keyof S]: K extends keyof ScalarSelection<Fields<Tables[T]>>
		? S[K] extends true
			? true
			: never
		: L extends readonly []
			? never
			: K extends keyof Edges<D, T>
				? S[K] extends true
					? never
					: ExactFilterMask<Tables, D, Extract<Target<Edges<D, T>[K]>, keyof Tables>, S[K], Tail<L>>
				: never
}
type ScalarValues<T extends RelationTable, S, Side extends 'input' | 'output'> = {
	[K in Extract<keyof S, keyof Fields<T>>]?: ScalarPredicate<Fields<T>[K], Side>
}
export type RelationFilters<
	Tables extends RelationTables,
	D extends RelationDeclarations,
	T extends keyof Tables,
	S,
	Side extends 'input' | 'output' = 'output',
	Level extends readonly 1[] = Depth,
> = Omit<ScalarValues<Tables[T], S, Side>, 'and' | 'or' | 'not' | 'fields'> & {
	fields?: ScalarValues<Tables[T], S, Side>
} & (Level extends readonly []
		? {}
		: {
				[K in Extract<keyof S, keyof Edges<D, T>>]?: Edges<D, T>[K] extends RelationEdge<
					string,
					infer Target,
					infer C
				>
					? C extends 'one'
						? RelationFilters<
								Tables,
								D,
								Extract<Target, keyof Tables>,
								S[K],
								Side,
								Tail<Level>
							> | null
						:
								| {
										some: RelationFilters<
											Tables,
											D,
											Extract<Target, keyof Tables>,
											S[K],
											Side,
											Tail<Level>
										>
								  }
								| {
										none: RelationFilters<
											Tables,
											D,
											Extract<Target, keyof Tables>,
											S[K],
											Side,
											Tail<Level>
										>
								  }
					: never
			} & {
				and?: RelationFilters<Tables, D, T, S, Side, Tail<Level>>[]
				or?: RelationFilters<Tables, D, T, S, Side, Tail<Level>>[]
				not?: RelationFilters<Tables, D, T, S, Side, Tail<Level>>
			})
type PublicRow<T extends RelationTable> = z.output<T['publicDto']> & {
	_id: GenericId<T['tableName']>
}
export type RelationRow<
	Tables extends RelationTables,
	D extends RelationDeclarations,
	T extends keyof Tables,
	S,
	Level extends readonly 1[] = Depth,
> = PublicRow<Tables[T]> &
	(Level extends readonly []
		? {}
		: {
				[K in keyof S]: K extends keyof Edges<D, T>
					? Edges<D, T>[K] extends RelationEdge<string, infer Target, infer C>
						? C extends 'one'
							? RelationRow<
									Tables,
									D,
									Extract<Target, keyof Tables>,
									S[K] extends true ? {} : S[K],
									Tail<Level>
								> | null
							: PaginationResult<
									RelationRow<
										Tables,
										D,
										Extract<Target, keyof Tables>,
										S[K] extends true ? {} : S[K],
										Tail<Level>
									>
								>
						: never
					: never
			})
export interface RelationTableHelpers<
	Tables extends RelationTables,
	D extends RelationDeclarations,
	T extends keyof Tables,
> {
	paginationOpts<const S extends RelationFilterSelection<Tables, D, T>>(
		selection: ExactFilterMask<Tables, D, T, S>,
	): PaginationOptionsSchema<
		RelationFilters<Tables, D, T, S>,
		RelationFilters<Tables, D, T, S, 'input'>
	>
	pageDto<const S extends RelationSelection<Tables, D, T>>(
		selection: ExactOutputMask<Tables, D, T, S>,
	): z.ZodType<PaginationResult<RelationRow<Tables, D, T, S>>>
}
export interface RelationRegistryIdentity {
	readonly identity: string
	readonly version: 1
}
export interface RelationRegistry<Tables extends RelationTables, D extends RelationDeclarations> {
	readonly identity: string
	readonly version: 1
	readonly tables: { [T in keyof Tables]: RelationTableHelpers<Tables, D, T> }
}

export interface RelationFieldMetadata {
	readonly kind: string
	readonly optional: boolean
	readonly nullable: boolean
	readonly idTables: readonly string[]
	readonly native: Readonly<ValidatorJSON>
}
export interface RelationTableMetadata {
	readonly fields: Readonly<Record<string, RelationFieldMetadata>>
	readonly indexes: readonly { readonly name: string; readonly fields: readonly string[] }[]
}
interface TableMetadata {
	fields: Record<string, GenericValidator>
	indexes: { name: string; fields: string[] }[]
	dto: z.ZodObject
	assertUnchanged(): void
}
interface RegistryMetadata {
	metadata: Record<string, TableMetadata>
	declarations: RelationDeclarations
}
export interface RelationMetadata {
	readonly tables: Readonly<Record<string, RelationTableMetadata>>
	readonly declarations: Readonly<Record<string, Readonly<Record<string, AnyEdge>>>>
}

const registries = new WeakMap<RelationRegistryIdentity, RelationMetadata>()
// Private executor state retains validators and projection, never a database reader.
const executorRegistries = new WeakMap<
	RelationRegistryIdentity,
	{
		internal: RegistryMetadata
		tables: RelationTables
		assertStoredUnchanged(): void
		assertNativeTable(table: string, definition: TableDefinition): void
	}
>()
const refs = new WeakMap<AnyField, GenericValidator>()
const throughRefs = new WeakSet<AnyThrough>()
const edgeRefs = new WeakSet<AnyEdge>()
const indexExport = z.object({
	indexes: z.array(z.object({ indexDescriptor: z.string(), fields: z.array(z.string()) })),
})

/** No ID-field inference and no readers: this registry owns declarations/schema helpers only. */
export function defineRelations<
	const Tables extends RelationTables,
	const D extends RelationDeclarations,
>(
	tables: Tables,
	declare: (r: RelationBuilder<Tables>) => D & ExactDeclarations<Tables, D>,
): RelationRegistry<Tables, D> {
	const metadata: Record<string, TableMetadata> = {}
	const ownRefs = new Set<AnyField>()
	const fields: Record<string, Record<string, AnyField>> = {}
	const one: Record<string, (spec: { from: Leg; to: Leg }) => AnyEdge> = {}
	const many: Record<string, (spec: { from: Leg; to: Leg }) => AnyEdge> = {}
	for (const [name, table] of Object.entries(tables)) {
		if (
			table.tableName !== name ||
			['one', 'many', '__proto__', 'constructor', 'prototype'].includes(name)
		)
			throw new Error(`Invalid relation table "${name}"`)
		const dto = table.dto(true)
		if (!(dto instanceof z.ZodObject)) throw new Error('Expected object DTO')
		const assertUnchanged = dtoMutationGuard(dto)
		const native = zodToConvex(table.schema)
		const exported = nativeTableExport(table.table)
		assertNativeValidation(exported.documentType)
		assertStoredDocument(name, native.fields, exported.documentType)
		const indexes = indexExport
			.parse(exported)
			.indexes.map((index) => ({ name: index.indexDescriptor, fields: [...index.fields] }))
			.sort((a, b) => a.name.localeCompare(b.name))
		assertNativeValidation(nativeJson(zodToConvex(dto)))
		metadata[name] = { fields: native.fields, indexes, dto, assertUnchanged }
		const tableRefs: Record<string, AnyField> = Object.create(null)
		for (const [field, validator] of Object.entries(native.fields)) {
			const ref: AnyField = {
				[fieldBrand]: undefined,
				table: name,
				field,
				through<J extends AnyField>(
					junction: J & (Same<any, J[typeof fieldBrand]> extends true ? {} : never),
				): ThroughReference<string, string, any, J> {
					const junctionValidator = refs.get(junction)
					if (
						!ownRefs.has(junction) ||
						!junctionValidator ||
						!compatible(validator, junctionValidator)
					)
						throw new Error('Invalid junction field or registry')
					const result = Object.freeze({ base: ref, junction })
					throughRefs.add(result)
					return result
				},
			}
			refs.set(ref, validator)
			ownRefs.add(ref)
			tableRefs[field] = Object.freeze(ref)
		}
		fields[name] = Object.freeze(tableRefs)
		one[name] = (spec) => makeEdge(name, 'one', spec, ownRefs)
		many[name] = (spec) => makeEdge(name, 'many', spec, ownRefs)
	}
	// SAFETY: every native field has a branded reference; mapped builders retain the literal names.
	const builder = Object.freeze({
		...fields,
		one: Object.freeze(one),
		many: Object.freeze(many),
	}) as RelationBuilder<Tables>
	const supplied = declare(builder)
	const declarations: RelationDeclarations = Object.fromEntries(
		Object.entries(supplied).map(([name, edges]) => [name, Object.freeze({ ...edges })]),
	)
	Object.freeze(declarations)
	for (const [source, edges] of Object.entries(declarations)) {
		if (!Object.hasOwn(tables, source)) throw new Error(`Unknown source table "${source}"`)
		for (const [name, edge] of Object.entries(edges)) {
			if (
				Object.hasOwn(metadata[source].fields, name) ||
				['and', 'or', 'not', 'fields', 'then', '__proto__', 'constructor', 'prototype'].includes(
					name,
				)
			)
				throw new Error(`Relation name collision "${name}"`)
			if (
				!edgeRefs.has(edge) ||
				!ownRefs.has(base(edge.from)) ||
				!ownRefs.has(base(edge.to)) ||
				edge.source !== source
			)
				throw new Error('Relation source bucket mismatch')
			validatePath(edge, metadata)
		}
	}
	const internal: RegistryMetadata = { metadata, declarations }
	const helpers: Record<
		string,
		{
			paginationOpts(selection: SelectionMask): z.ZodType
			pageDto(selection: SelectionMask): z.ZodType
		}
	> = {}
	for (const table of Object.keys(tables))
		helpers[table] = {
			paginationOpts(selection: SelectionMask): z.ZodType {
				assertRegistryUnchanged(internal)
				assertSelection(selection)
				return guardedDto(
					nativePagination.extend({
						filters: relationFilterSchema(filterGrammar(internal, table, selection)).optional(),
						order: z.enum(['asc', 'desc']).optional(),
					}),
					() => assertRegistryUnchanged(internal),
				)
			},
			pageDto(selection: SelectionMask): z.ZodType {
				assertRegistryUnchanged(internal)
				assertSelection(selection)
				return guardedDto(paginated(rowSchema(internal, table, selection)).result, () =>
					assertRegistryUnchanged(internal),
				)
			},
		}
	// Stable, collision-free canonical metadata encoding. It is an identity, not a secret/hash.
	const identity = JSON.stringify([
		1,
		Object.entries(metadata)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, data]) => [
				name,
				Object.entries(data.fields)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([field, validator]) => [field, validator.isOptional, nativeJson(validator)]),
				data.indexes,
				canonicalNative(nativeJson(zodToConvex(data.dto))),
			]),
		Object.entries(declarations)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([source, edges]) => [
				source,
				Object.entries(edges)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([name, edge]) => [
						name,
						edge.cardinality,
						edge.target,
						serializeLeg(edge.from),
						serializeLeg(edge.to),
					]),
			]),
	])
	// SAFETY: helpers are assembled for every validated literal table and mask; schemas derive matching native fields/public DTOs.
	const registry = Object.freeze({
		identity,
		version: 1,
		tables: Object.freeze(helpers),
	}) as RelationRegistry<Tables, D>
	registries.set(registry, snapshotMetadata(internal))
	const ownedTables = Object.freeze({ ...tables })
	const storedGuards = Object.fromEntries(
		Object.entries(ownedTables).map(([name, table]) => {
			const schemaGuard = schemaMutationGuard(table.schema, 'stored')
			const nativeSnapshot = JSON.stringify(nativeTableExport(table.table))
			return [
				name,
				() => {
					schemaGuard()
					if (JSON.stringify(nativeTableExport(table.table)) !== nativeSnapshot)
						throw new Error(`Native schema mutated after registry construction: ${name}`)
				},
			]
		}),
	)
	executorRegistries.set(registry, {
		internal,
		tables: ownedTables,
		assertStoredUnchanged: () => {
			for (const guard of Object.values(storedGuards)) guard()
		},
		assertNativeTable(table, definition) {
			if (!Object.hasOwn(ownedTables, table) || ownedTables[table].table !== definition)
				throw new Error('Native schema/table ownership disagrees with relation registry')
			storedGuards[table]()
		},
	})
	return registry
}

/** Internal owned executor bridge. Not an advertised root API. Every operation
 * rechecks the live registry, including cached plans and individual projections.
 */
export function getRelationExecutor(registry: RelationRegistryIdentity) {
	const owned = executorRegistries.get(registry)
	if (!owned) throw new Error('Unknown relation registry')
	const assertUnchanged = () => {
		assertRegistryUnchanged(owned.internal)
		owned.assertStoredUnchanged()
	}
	const assertSchema = (tables: Readonly<Record<string, TableDefinition>>) => {
		assertUnchanged()
		const names = Object.keys(owned.tables)
		if (
			names.length !== Object.keys(tables).length ||
			names.some((name) => tables[name] !== owned.tables[name].table)
		)
			throw new Error('Native schema/table ownership disagrees with relation registry')
	}
	assertUnchanged()
	return Object.freeze({
		assertUnchanged,
		assertNativeTable: owned.assertNativeTable,
		assertSchema,
		pagination(table: string) {
			assertUnchanged()
			const internal = owned.internal
			const scalarFields = new Map<string, FieldSchemas>()
			function grammar(name: string, depth: number): FilterGrammar {
				const data = internal.metadata[name]
				if (!data) throw new Error('Unknown query table')
				let fields = scalarFields.get(name)
				if (!fields) {
					fields = {}
					for (const [name, validator] of Object.entries(data.fields)) {
						// Unsupported stored containers are not scalar-queryable. No validators
						// are reconstructed from JSON; these are the actual native validators.
						if (scalarValidator(validator))
							fields[name] = scalarPredicateSchema(validator).optional()
					}
					scalarFields.set(name, fields)
				}
				return {
					fields,
					relations:
						depth >= 4
							? {}
							: Object.fromEntries(
									Object.entries(internal.declarations[name] ?? {}).map(([edge, declaration]) => [
										edge,
										{
											cardinality: declaration.cardinality,
											target: grammar(declaration.target, depth + 1),
										},
									]),
								),
				}
			}
			return nativePagination.extend({
				filters: relationFilterSchema(grammar(table, 0)).optional(),
				order: z.enum(['asc', 'desc']).optional(),
			})
		},
		page(table: string, selection: SelectionMask) {
			assertUnchanged()
			assertSelection(selection)
			return paginated(rowSchema(owned.internal, table, selection)).result
		},
		project(
			tables: Readonly<Record<string, TableDefinition>>,
			table: string,
			row: Record<string, import('convex/values').Value>,
			eligible: () => boolean,
		) {
			assertSchema(tables)
			if (!eligible()) return null
			const dto = owned.internal.metadata[table]?.dto
			if (!dto) throw new Error('Unknown query table')
			// The strict DTO remains the authority. Pick its fields before parsing,
			// matching table projection without spreading any storage-only fields.
			return dto.parse(
				Object.fromEntries(
					Object.keys(dto.shape)
						.filter((key) => Object.hasOwn(row, key))
						.map((key) => [key, row[key]]),
				),
			)
		},
	})
}
/** Internal compiler/engine adapter. Registry identity alone cannot forge a registry. */
export function getRelationMetadata(registry: RelationRegistryIdentity): RelationMetadata {
	const metadata = registries.get(registry)
	if (!metadata) throw new Error('Unknown relation registry')
	return metadata
}

function scalarValidator(validator: GenericValidator): boolean {
	return (
		['id', 'string', 'float64', 'int64', 'boolean', 'null', 'literal'].includes(validator.kind) ||
		(validator.kind === 'union' && validator.members.every(scalarValidator))
	)
}

function assertSelection(selection: SelectionMask): void {
	const pending: { value: SelectionMask; depth: number; ancestors: readonly SelectionMask[] }[] = [
		{ value: selection, depth: 0, ancestors: [] },
	]
	let nodes = 0
	while (pending.length) {
		const { value, depth, ancestors } = pending.pop()!
		if (++nodes > 256 || depth > 4 || ancestors.includes(value))
			throw new Error('Selection cycle or depth/node budget exceeded')
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new Error('Invalid selection')
		const keys = Reflect.ownKeys(value)
		if (keys.length + nodes + pending.length > 256)
			throw new Error('Selection node budget exceeded')
		for (const key of keys) {
			const property = Object.getOwnPropertyDescriptor(value, key)!
			if (!property.enumerable || !('value' in property) || String(key) !== key)
				throw new Error('Invalid selection property')
			if (property.value !== true)
				pending.push({ value: property.value, depth: depth + 1, ancestors: [...ancestors, value] })
			else if (++nodes > 256) throw new Error('Selection node budget exceeded')
		}
	}
}
function base(leg: Leg): AnyField {
	return 'base' in leg ? leg.base : leg
}
function makeEdge(
	target: string,
	cardinality: 'one' | 'many',
	spec: { from: Leg; to: Leg },
	own: Set<AnyField>,
): AnyEdge {
	for (const leg of [spec.from, spec.to]) {
		if (!own.has(base(leg)) || ('base' in leg && (!throughRefs.has(leg) || !own.has(leg.junction))))
			throw new Error('Foreign registry or invalid field reference')
	}
	if (base(spec.to).table !== target) throw new Error('Wrong relation target table')
	const result: AnyEdge = Object.freeze({
		[edgeBrand]: true as const,
		source: base(spec.from).table,
		target,
		cardinality,
		from: spec.from,
		to: spec.to,
	})
	edgeRefs.add(result)
	return result
}
function compatible(left: GenericValidator, right: GenericValidator): boolean {
	const leftDomain = domain(left)
	return leftDomain.length > 0 && JSON.stringify(leftDomain) === JSON.stringify(domain(right))
}
function domain(validator: GenericValidator): string[] {
	if (validator.kind === 'union') return [...new Set(validator.members.flatMap(domain))].sort()
	if (validator.kind === 'null') return []
	if (!['id', 'string', 'float64', 'int64', 'boolean', 'literal'].includes(validator.kind))
		throw new Error('Unsupported relation field kind')
	return [JSON.stringify(nativeJson(validator))]
}
function validatePath(edge: AnyEdge, metadata: Record<string, TableMetadata>): void {
	const from = edge.from
	const to = edge.to
	if ('base' in from !== 'base' in to) throw new Error('Both relation legs must use through')
	if ('base' in from && 'base' in to) {
		if (from.junction.table !== to.junction.table) throw new Error('Different junction tables')
		requireIndex(metadata, from.junction.table, from.junction.field)
		requireIndex(metadata, edge.target, to.base.field)
		return
	}
	if (!compatible(refs.get(base(from))!, refs.get(base(to))!))
		throw new Error('Incompatible relation field types')
	requireIndex(metadata, edge.target, base(to).field)
}
function requireIndex(metadata: Record<string, TableMetadata>, table: string, field: string): void {
	if (field !== '_id' && !metadata[table].indexes.some((index) => index.fields[0] === field))
		throw new Error(`No active index begins with "${table}.${field}"`)
}
function serializeLeg(leg: Leg): string[] {
	return 'base' in leg
		? [leg.base.table, leg.base.field, leg.junction.table, leg.junction.field]
		: [leg.table, leg.field]
}
function filterGrammar(
	registry: RegistryMetadata,
	table: string,
	selection: SelectionMask,
	depth: number = 0,
): FilterGrammar {
	const fields: FieldSchemas = {}
	const relations: FilterGrammar['relations'] = {}
	for (const [key, mask] of Object.entries(selection)) {
		const validator = registry.metadata[table].fields[key]
		const edge = registry.declarations[table]?.[key]
		if (mask === true && validator) fields[key] = scalarPredicateSchema(validator).optional()
		else if (mask !== true && edge && depth < 4)
			relations[key] = {
				cardinality: edge.cardinality,
				target: filterGrammar(registry, edge.target, mask, depth + 1),
			}
		else throw new Error(`Invalid relation filter selection "${table}.${key}"`)
	}
	return { fields, relations }
}
function rowSchema(
	registry: RegistryMetadata,
	table: string,
	selection: SelectionMask,
	depth: number = 0,
): z.ZodType {
	const relationFields: FieldSchemas = {}
	for (const [name, mask] of Object.entries(selection)) {
		const edge = registry.declarations[table]?.[name]
		if (!edge || depth >= 4) throw new Error(`Unknown or too deep relation "${table}.${name}"`)
		const target =
			mask === true
				? registry.metadata[edge.target].dto
				: rowSchema(registry, edge.target, mask, depth + 1)
		relationFields[name] = edge.cardinality === 'one' ? target.nullable() : paginated(target).result
	}
	// Keep caller validations; guard the supported graph before parsing or native conversion.
	const dto = registry.metadata[table].dto
	if (!(dto instanceof z.ZodObject)) throw new Error('Expected object DTO')
	return guardedDto(dto.extend(relationFields).strict(), () => assertRegistryUnchanged(registry))
}

interface NativeTableExport {
	indexes: { indexDescriptor: string; fields: string[] }[]
	documentType: ValidatorJSON
}
function nativeTableExport(table: TableDefinition): NativeTableExport {
	// SAFETY: Convex exposes export at runtime but strips its internal signature from declarations.
	return (table as TableDefinition & { export(): NativeTableExport }).export()
}
function nativeJson(validator: GenericValidator): ValidatorJSON {
	// SAFETY: native validators expose converter metadata at runtime; Convex strips json from declarations.
	return (validator as GenericValidator & { json: ValidatorJSON }).json
}

function canonicalNative(value: JSONValue): string {
	if (Array.isArray(value)) return `[${value.map(canonicalNative).join(',')}]`
	if (value !== null && Object(value) === value) {
		// SAFETY: native JSON contains only JSON objects, arrays and primitives.
		const object = value as { [key: string]: JSONValue }
		return `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalNative(object[key])}`)
			.join(',')}}`
	}
	return JSON.stringify(value)
}

function assertNativeValidation(value: JSONValue): void {
	if (value === null || Object(value) !== value) return
	// SAFETY: native converter metadata contains only JSON containers and primitives.
	const container = value as { [key: string]: JSONValue }
	if (container.type === 'any') throw new Error('Unsupported native validation form')
	for (const child of Object.values(container)) assertNativeValidation(child)
}

function assertStoredDocument(
	table: string,
	fields: Record<string, GenericValidator>,
	document: ValidatorJSON,
): void {
	const { _id, _creationTime, ...stored } = fields
	if (
		!_id ||
		!_creationTime ||
		canonicalNative(nativeJson(_id)) !== canonicalNative(nativeJson(v.id(table))) ||
		canonicalNative(nativeJson(_creationTime)) !== canonicalNative(nativeJson(v.number())) ||
		_id.isOptional !== 'required' ||
		_creationTime.isOptional !== 'required' ||
		canonicalNative(document) !== canonicalNative(nativeJson(v.object(stored)))
	)
		throw new Error(`Native stored document disagrees with boundary "${table}"`)
}

interface DtoGraphNode {
	object: object
	exactKeys: boolean
	keys: readonly PropertyKey[]
	values: readonly PropertyDescriptor[]
}

// Compare against this peer's own built-in accessor, using the intrinsic rather
// than a caller-provided toString. Older Zod clones retain this accessor even
// after reading shape, because it caches on the original definition.
const objectAccessorSample = z.object({ field: z.string() })
const builtinObjectGetters = new Set(
	[
		objectAccessorSample,
		objectAccessorSample.pick({ field: true }),
		objectAccessorSample.omit({ field: true }),
		objectAccessorSample.extend({ other: z.string() }),
		objectAccessorSample.safeExtend({ other: z.string() }),
		objectAccessorSample.merge(z.object({ other: z.string() })),
		objectAccessorSample.partial(),
		objectAccessorSample.required(),
	].flatMap((schema) => {
		const getter = Object.getOwnPropertyDescriptor(schema._zod.def, 'shape')?.get
		return getter ? [Function.prototype.toString.call(getter)] : []
	}),
)

/** Snapshot supported value-validation definitions, not Zod's mutable parse caches.
 * Functions remain the original validation functions; their captured application state
 * is outside the schema contract. Lazy/transform/default/coercion nodes fail closed.
 */
function dtoMutationGuard(dto: z.ZodObject): () => void {
	return schemaMutationGuard(dto, 'dto')
}

// Stored schemas already passed the native input boundary. Track their graph
// independently of public DTO admissibility, without running any stored parser.
const builtinDefaultGetter = Function.prototype.toString.call(
	Object.getOwnPropertyDescriptor(z.string().default('')._zod.def, 'defaultValue')!.get!,
)
const builtinPrefaultGetter = Function.prototype.toString.call(
	Object.getOwnPropertyDescriptor(z.string().prefault('')._zod.def, 'defaultValue')!.get!,
)

function schemaMutationGuard(dto: z.ZodObject, boundary: 'dto' | 'stored'): () => void {
	const nodes: DtoGraphNode[] = []
	const fallbackDefinitions = new Set<object>()
	const patterns: { expression: RegExp; source: string; flags: string }[] = []
	const seen = new Set<object>()
	const active = new Set<object>()
	const objectFields: {
		definition: z.core.$ZodObjectDef
		fields: Record<string, z.core.$ZodType>
	}[] = []
	function visit(value: DtoGraphNode['object'], depth: number): void {
		if (active.has(value)) throw new Error('Unsupported cyclic DTO schema')
		if (seen.has(value)) return
		if (depth > 32 || nodes.length >= 4096) throw new Error('DTO schema graph budget exceeded')
		seen.add(value)
		active.add(value)
		try {
			if (value instanceof RegExp)
				patterns.push({ expression: value, source: value.source, flags: value.flags })
			if (value instanceof z.core.$ZodCheck && 'check' in value._zod.def) {
				if (boundary === 'dto' && value._zod.def.check === 'overwrite')
					throw new Error('Unsupported DTO overwrite check')
				visit(value._zod.def, depth + 1)
				nodes.push({
					object: value._zod,
					exactKeys: false,
					keys: ['def', 'check'],
					values: ['def', 'check'].map((key) => Object.getOwnPropertyDescriptor(value._zod, key)!),
				})
				return
			}
			if (value instanceof z.core.$ZodType) {
				// SAFETY: built-in Zod definitions form a discriminated union.
				const def = (value as z.core.$ZodTypes)._zod.def
				if (
					boundary === 'dto' &&
					(![
						'object',
						'array',
						'optional',
						'nullable',
						'nonoptional',
						'union',
						'intersection',
						'tuple',
						'record',
						'string',
						'number',
						'boolean',
						'bigint',
						'null',
						'never',
						'literal',
						'enum',
					].includes(def.type) ||
						('coerce' in def && def.coerce))
				)
					throw new Error(`Unsupported DTO schema "${def.type}"`)
				if (boundary === 'stored' && (def.type === 'default' || def.type === 'prefault')) {
					const descriptor = Object.getOwnPropertyDescriptor(def, 'defaultValue')
					if (descriptor?.get) {
						if (
							descriptor.set ||
							Function.prototype.toString.call(descriptor.get) !==
								(def.type === 'default' ? builtinDefaultGetter : builtinPrefaultGetter)
						)
							throw new Error('Unsupported stored schema accessor')
						// Snapshot the accessor identity below, never evaluate its fallback.
						fallbackDefinitions.add(def)
					}
				}
				if (def.type === 'object') {
					const descriptor = Object.getOwnPropertyDescriptor(def, 'shape')
					if (descriptor?.get) {
						if (
							descriptor.set ||
							!builtinObjectGetters.has(Function.prototype.toString.call(descriptor.get))
						)
							throw new Error('Unsupported DTO schema accessor')
						const fields = def.shape
						visit(fields, depth + 1)
						// A refined clone's getter can return fresh shallow copies.
						// Preserve that caller behavior and compare its fields separately.
						if (Object.getOwnPropertyDescriptor(def, 'shape')?.get)
							objectFields.push({ definition: def, fields })
					}
					if (value instanceof z.ZodObject) {
						const publicFields = Object.getOwnPropertyDescriptor(value, 'shape')
						if (publicFields && !('value' in publicFields))
							throw new Error('Unsupported DTO schema accessor')
						visit(value.shape, depth + 1)
					}
				}
				visit(def, depth + 1)
				// Track definition replacement, without snapshotting caches initialized by parsing.
				nodes.push({
					object: value._zod,
					exactKeys: false,
					keys: ['def'],
					values: [Object.getOwnPropertyDescriptor(value._zod, 'def')!],
				})
				return
			}
			const keys = Reflect.ownKeys(value)
			const values = keys.map((key) => Object.getOwnPropertyDescriptor(value, key)!)
			if (
				values.some(
					(property, i) =>
						!('value' in property) &&
						!objectFields.some(({ definition }) => definition === value && keys[i] === 'shape') &&
						!(fallbackDefinitions.has(value) && keys[i] === 'defaultValue'),
				)
			)
				throw new Error('Unsupported DTO schema accessor')
			nodes.push({ object: value, exactKeys: true, keys, values })
			for (const property of values) {
				if (
					property.value !== null &&
					Object(property.value) === property.value &&
					!(property.value instanceof Function)
				)
					visit(property.value, depth + 1)
			}
		} finally {
			active.delete(value)
		}
	}
	visit(dto, 0)
	return () => {
		for (const pattern of patterns)
			if (
				pattern.expression.source !== pattern.source ||
				pattern.expression.flags !== pattern.flags
			)
				throw new Error('DTO schema mutated after registry construction')
		for (const node of nodes) {
			const keys = node.keys
			if (node.exactKeys && Reflect.ownKeys(node.object).length !== keys.length)
				throw new Error('DTO schema mutated after registry construction')
			for (let i = 0; i < keys.length; i++) {
				// Regex checks may update lastIndex while parsing; pattern identity is checked above.
				if (node.object instanceof RegExp && keys[i] === 'lastIndex') continue
				const current = Object.getOwnPropertyDescriptor(node.object, keys[i])
				const before = node.values[i]
				if (
					!current ||
					current.value !== before.value ||
					current.get !== before.get ||
					current.set !== before.set ||
					current.enumerable !== before.enumerable
				)
					throw new Error('DTO schema mutated after registry construction')
			}
		}
		for (const { definition, fields } of objectFields) {
			const current = definition.shape
			const keys = Reflect.ownKeys(fields)
			if (
				Reflect.ownKeys(current).length !== keys.length ||
				keys.some(
					(key) =>
						Object.getOwnPropertyDescriptor(current, key)?.value !==
						Object.getOwnPropertyDescriptor(fields, key)?.value,
				)
			)
				throw new Error('DTO schema mutated after registry construction')
		}
	}
}

function assertRegistryUnchanged(registry: RegistryMetadata): void {
	for (const table of Object.values(registry.metadata)) table.assertUnchanged()
}

interface GuardedDtoDefinition extends z.core.$ZodObjectDef {
	assertUnchanged(): void
}
const GuardedDtoObject = z.core.$constructor<z.ZodObject>('GuardedDtoObject', (inst, def) => {
	// SAFETY: only guardedDto creates this definition; Zod clones retain its guard.
	const guarded = def as GuardedDtoDefinition
	z.ZodObject.init(inst, def)
	// Run after Zod's own deferred initializers, including its memoizer wrapper.
	// Guarding parse alone is too late for first-run schema introspection.
	inst._zod.deferred ??= []
	inst._zod.deferred.push(() => {
		const run = inst._zod.run
		inst._zod.run = (payload, ctx) => {
			try {
				guarded.assertUnchanged()
			} catch {
				payload.issues.push({
					code: 'custom',
					input: payload.value,
					message: 'DTO schema mutated after registry construction',
				})
				return payload
			}
			return run(payload, ctx)
		}
	})
})
function guardedDto(dto: z.ZodObject, assertUnchanged: () => void): z.ZodObject {
	const outputFields = dto.shape
	const def: GuardedDtoDefinition = { ...dto._zod.def, assertUnchanged }
	Object.defineProperty(def, 'shape', {
		enumerable: true,
		configurable: true,
		get: () => {
			assertUnchanged()
			return outputFields
		},
	})
	return new GuardedDtoObject(def)
}

function snapshotMetadata(registry: RegistryMetadata): RelationMetadata {
	const tables: Record<string, RelationTableMetadata> = {}
	for (const [name, data] of Object.entries(registry.metadata)) {
		const fields: Record<string, RelationFieldMetadata> = {}
		for (const [field, validator] of Object.entries(data.fields))
			fields[field] = Object.freeze({
				kind: validator.kind,
				optional: validator.isOptional === 'optional',
				nullable: hasNull(validator),
				idTables: Object.freeze(idTables(validator)),
				native: frozenNative(nativeJson(validator)),
			})
		tables[name] = Object.freeze({
			fields: Object.freeze(fields),
			indexes: Object.freeze(
				data.indexes.map((index) =>
					Object.freeze({ name: index.name, fields: Object.freeze([...index.fields]) }),
				),
			),
		})
	}
	return Object.freeze({ tables: Object.freeze(tables), declarations: registry.declarations })
}
function hasNull(validator: GenericValidator): boolean {
	return (
		validator.kind === 'null' || (validator.kind === 'union' && validator.members.some(hasNull))
	)
}
function idTables(validator: GenericValidator): string[] {
	return validator.kind === 'id'
		? [validator.tableName]
		: validator.kind === 'union'
			? [...new Set(validator.members.flatMap(idTables))].sort()
			: []
}
function frozenNative(native: ValidatorJSON): Readonly<ValidatorJSON> {
	const snapshot = structuredClone(native)
	const pending: JSONValue[] = [snapshot]
	while (pending.length) {
		const next = pending.pop()!
		if (Object(next) !== next) continue
		// SAFETY: native JSON metadata contains ordinary arrays/objects; the boxing test excludes primitives.
		const container = next as JSONValue[] | { [key: string]: JSONValue }
		Object.freeze(container)
		pending.push(...Object.values(container))
	}
	return snapshot
}
