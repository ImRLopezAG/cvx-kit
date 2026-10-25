import { z } from 'zod'
import { captureDto, materializeDto, type DtoRecipe } from './querying/schema-snapshot'
import { zodToConvex, convexToZod, type ConvexValidatorFromZod } from 'convex-helpers/server/zod4'
import { defineSchema, defineTable, type TableDefinition } from 'convex/server'
import {
	v,
	type GenericId,
	type GenericValidator,
	type ValidatorJSON,
	type JSONValue,
} from 'convex/values'
import { paginated, type EnginePaginationResult } from './zod-table'
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

const paginationRecipe = captureDto(nativePagination)

/** Generated object or discriminated-union boundaries. */
export interface RelationTable {
	tableName: string
	schema: z.ZodObject | z.ZodDiscriminatedUnion<any, string>
	publicDto: z.ZodObject | z.ZodDiscriminatedUnion<any, string>
	table: TableDefinition
	dto(includeId: true): z.ZodType
}
export type RelationTables = Record<string, RelationTable>
/** Internal named declaration dependency; excluded from the supported relations facade. */
export interface SelectionMask {
	[key: string]: true | SelectionMask
}
type DocumentFields<S> =
	S extends z.ZodObject<infer F>
		? F
		: S extends z.ZodDiscriminatedUnion<infer O, string>
			? O[number] extends infer B
				? B extends z.ZodObject<infer F>
					? F
					: never
				: never
			: never
type AllKeys<F> = F extends unknown ? keyof F : never
type FieldAt<F, K extends PropertyKey> = F extends unknown
	? K extends keyof F
		? F[K]
		: never
	: never
type NativeDomain<V> = V extends { kind: 'union'; members: infer M extends GenericValidator[] }
	? NativeDomain<M[number]>
	: V extends { kind: 'null' }
		? never
		: V extends { kind: infer K; type: infer Value }
			? readonly [K, Exclude<Value, undefined>]
			: never
type DomainAt<F, K extends PropertyKey> = F extends unknown
	? K extends keyof F
		? F[K] extends z.ZodType
			? NativeDomain<ConvexValidatorFromZod<F[K], 'required'>>
			: never
		: never
	: never
type CompatibleBranches<F, K extends keyof F, Domain = DomainAt<F, K>> = F extends unknown
	? Same<DomainAt<F, K>, Domain>
	: never
type Discriminator<T extends RelationTable> =
	T['schema'] extends z.ZodDiscriminatedUnion<any, string>
		? T['schema']['_zod']['def']['discriminator']
		: never
type Fields<
	T extends RelationTable,
	F = DocumentFields<T['schema']>,
> = string extends T['tableName']
	? FieldSchemas
	: T['schema'] extends z.ZodObject<infer ObjectFields>
		? { [K in keyof ObjectFields]: Extract<ObjectFields[K], z.ZodType> }
		: {
				[
					K in Extract<keyof F, string> as K extends Discriminator<T>
						? K
						: false extends CompatibleBranches<F, K>
							? never
							: K
				]: Extract<FieldAt<F, K>, z.ZodType>
			}
type BranchFields<T extends RelationTable, Tag extends string> =
	DocumentFields<T['schema']> extends infer F
		? F extends Record<Discriminator<T>, z.ZodType>
			? Tag extends z.output<F[Discriminator<T>]>
				? F
				: never
			: never
		: never
type Tags<T extends RelationTable> =
	T['schema'] extends z.ZodDiscriminatedUnion<any, string>
		? Extract<z.output<T['schema']>[Discriminator<T>], string>
		: never
type Native<T extends RelationTable, K extends keyof Fields<T>> = ConvexValidatorFromZod<
	Fields<T>[K],
	'required'
>['type']
const fieldBrand: unique symbol = Symbol('relationField')
const edgeBrand: unique symbol = Symbol('relationEdge')
type Comparable<Value> = Exclude<Value, null | undefined>
type IdMembers<Value, Registered extends string> = [Comparable<Value>] extends [never]
	? never
	: [Comparable<Value>] extends [GenericId<string>]
		? Extract<Comparable<Value>, GenericId<string>>['__tableName'] & Registered
		: never
type Same<A, B> = [Comparable<A> | Comparable<B>] extends [never]
	? false
	: [Comparable<A>] extends [Comparable<B>]
		? [Comparable<B>] extends [Comparable<A>]
			? true
			: false
		: false

export interface FieldReference<
	Table extends string,
	Field extends string,
	Value,
	Scope extends string = never,
	Registered extends string = string,
	Member extends string = never,
> {
	readonly guard?: RelationGuard<Scope>
	readonly [fieldBrand]: Value
	readonly table: Table
	readonly field: Field
	/** Select a registered native-ID member, retaining this field's nullish wrappers. */
	forTable<const T extends ([Scope] extends [never] ? IdMembers<Value, Registered> : never)>(
		table: T,
	): FieldReference<
		Table,
		Field,
		Extract<Value, GenericId<T> | null | undefined>,
		Scope,
		Registered,
		T
	>
	through<J extends AnyField>(
		junction: J &
			([Member] extends [never] ? {} : never) &
			(J extends FieldReference<string, string, any, any, any, infer M>
				? [M] extends [never]
					? {}
					: never
				: never) &
			(Same<Value, J[typeof fieldBrand]> extends true ? {} : never),
	): ThroughReference<Table, Field, Value, J, Scope>
}
export interface RelationGuard<Tag extends string = string> {
	readonly discriminator: string
	readonly tag: Tag
}
type AnyField = FieldReference<string, string, any, any, any, any>
export interface ThroughReference<
	Table extends string,
	Field extends string,
	Value,
	Junction extends AnyField,
	Scope extends string = never,
> {
	readonly base: FieldReference<Table, Field, Value, Scope>
	readonly junction: Junction
}
type AnyThrough = ThroughReference<string, string, any, AnyField, any>
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
	SourceScope extends string = never,
	TargetScope extends string = never,
> {
	readonly sourceGuard?: RelationGuard<SourceScope>
	readonly targetGuard?: RelationGuard<TargetScope>
	readonly junctionGuard?: RelationGuard
	readonly sourceMember?: RelationMember
	readonly targetMember?: RelationMember
	readonly [edgeBrand]: true
	readonly source: Source
	readonly target: Target
	readonly cardinality: Cardinality
	readonly from: Leg
	readonly to: Leg
}
interface RelationMember {
	readonly table: string
}
type AnyEdge = RelationEdge<string, string, 'one' | 'many', any, any>
type FieldReferences<Tables extends RelationTables> = {
	[T in keyof Tables]: {
		[K in Extract<keyof Fields<Tables[T]>, string>]: FieldReference<
			Extract<T, string>,
			K,
			Native<Tables[T], K>,
			never,
			Extract<keyof Tables, string>
		>
	}
}
export type BranchBuilder<Tables extends RelationTables> = <
	const T extends keyof Tables & string,
	const Tag extends Tags<Tables[T]>,
>(
	table: T,
	tag: Tag,
) => {
	[K in keyof BranchFields<Tables[T], Tag> & string]: FieldReference<
		T,
		K,
		ConvexValidatorFromZod<Extract<BranchFields<Tables[T], Tag>[K], z.ZodType>, 'required'>['type'],
		Tag
	>
}
type Scope<L extends Leg> = NonNullable<Base<L>['guard']>['tag']
type AllReferences<Tables extends RelationTables> = {
	[T in keyof Tables]: FieldReferences<Tables>[T][Extract<keyof FieldReferences<Tables>[T], string>]
}[keyof Tables]
type Builders<Tables extends RelationTables, C extends 'one' | 'many'> = {
	[T in keyof Tables]: <
		F extends AllReferences<Tables> | AnyField | AnyThrough,
		To extends
			| FieldReferences<Tables>[T][Extract<keyof FieldReferences<Tables>[T], string>]
			| AnyField
			| AnyThrough,
	>(
		spec: { from: F; to: To } & CompatibleLegs<F, To> & (Base<To>['table'] extends T ? {} : never),
	) => RelationEdge<Base<F>['table'], Extract<T, string>, C, Scope<F>, Scope<To>>
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
					| AllKeys<DocumentFields<Tables[T]['schema']>>
					| 'and'
					| 'or'
					| 'not'
					| 'fields'
					| 'then'
					| ([Tags<Tables[T]>] extends [never] ? never : 'variant' | 'variants')
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
type BranchTables<Tables extends RelationTables, T extends keyof Tables, Tag extends string> = {
	[K in keyof Tables]: K extends T
		? Omit<Tables[K], 'schema'> & { schema: z.ZodObject<BranchFields<Tables[T], Tag>> }
		: Tables[K]
}
type VariantSelections<
	Tables extends RelationTables,
	D extends RelationDeclarations,
	T extends keyof Tables,
	Level extends readonly 1[],
> = {
	[Tag in Tags<Tables[T]>]?: RelationFilterSelection<BranchTables<Tables, T, Tag>, D, T, Level>
}
export type RelationFilterSelection<
	Tables extends RelationTables,
	D extends RelationDeclarations,
	T extends keyof Tables,
	Level extends readonly 1[] = Depth,
> = ([Tags<Tables[T]>] extends [never]
	? ScalarSelection<Fields<Tables[T]>>
	: Omit<ScalarSelection<Fields<Tables[T]>>, 'variants'> & {
			variants?:
				| ('variants' extends keyof ScalarSelection<Fields<Tables[T]>> ? true : never)
				| VariantSelections<Tables, D, T, Level>
		}) &
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
	[K in keyof S]: K extends ([Tags<Tables[T]>] extends [never] ? never : 'variants')
		? S[K] extends true
			? K extends keyof ScalarSelection<Fields<Tables[T]>>
				? true
				: never
			: S[K] & {
					[Tag in keyof S[K]]: Tag extends Tags<Tables[T]>
						? ExactFilterMask<
								BranchTables<Tables, T, Extract<Tag, string>>,
								D,
								T,
								S[K][Tag],
								Tail<L>
							>
						: never
				}
		: K extends keyof ScalarSelection<Fields<Tables[T]>>
			? S[K] extends true
				? true
				: never
			: L extends readonly []
				? never
				: K extends keyof Edges<D, T>
					? S[K] extends true
						? never
						: ExactFilterMask<
								Tables,
								D,
								Extract<Target<Edges<D, T>[K]>, keyof Tables>,
								S[K],
								Tail<L>
							>
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
> = Omit<
	ScalarValues<Tables[T], S, Side>,
	'and' | 'or' | 'not' | 'fields' | ([Tags<Tables[T]>] extends [never] ? never : 'variant')
> & {
	fields?: ScalarValues<Tables[T], S, Side>
} & VariantFilters<Tables, D, T, S, Side, Level> &
	(Level extends readonly []
		? {}
		: {
				[K in Extract<keyof S, keyof Edges<D, T>>]?: Edges<D, T>[K] extends RelationEdge<
					string,
					infer Target,
					infer C,
					any,
					any
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
				and?: readonly RelationFilters<Tables, D, T, S, Side, Tail<Level>>[]
				or?: readonly RelationFilters<Tables, D, T, S, Side, Tail<Level>>[]
				not?: RelationFilters<Tables, D, T, S, Side, Tail<Level>>
			})
type VariantFilters<
	Tables extends RelationTables,
	D extends RelationDeclarations,
	T extends keyof Tables,
	S,
	Side extends 'input' | 'output',
	L extends readonly 1[],
> = L extends readonly []
	? {}
	: S extends { variants: infer V }
		? V extends true
			? {}
			: {
					variant?: {
						[Tag in keyof V]: Tag extends Tags<Tables[T]>
							? {
									tag: Tag
									filters: RelationFilters<
										BranchTables<Tables, T, Extract<Tag, string>>,
										D,
										T,
										V[Tag] & Omit<S, 'variants'>,
										Side,
										Tail<L>
									>
								}
							: never
					}[keyof V]
				}
		: {}
type PublicRow<T extends RelationTable> = z.output<T['publicDto']> & {
	_id: GenericId<T['tableName']>
}
export type ScopedRelationRow<Row, Scope extends string, Key extends PropertyKey> = [
	Scope,
] extends [never]
	? Row
	: Extract<Row, Record<Key, Scope>>
type ComposeRelationRow<
	Tables extends RelationTables,
	D extends RelationDeclarations,
	T extends keyof Tables,
	S,
	Level extends readonly 1[],
	Row,
> = Row extends unknown
	? Row &
			(Level extends readonly []
				? {}
				: {
						[K in keyof S]: K extends keyof Edges<D, T>
							? Edges<D, T>[K] extends RelationEdge<
									string,
									infer Target,
									infer C,
									infer SourceScope,
									infer TargetScope
								>
								? C extends 'one'
									? (
											[SourceScope] extends [never]
												? true
												: Row extends ScopedRelationRow<Row, SourceScope, Discriminator<Tables[T]>>
													? true
													: false
										) extends true
										? ScopedRelationRow<
												RelationRow<
													Tables,
													D,
													Extract<Target, keyof Tables>,
													S[K] extends true ? {} : S[K],
													Tail<Level>
												>,
												TargetScope,
												Discriminator<Tables[Extract<Target, keyof Tables>]>
											> | null
										: null
									: EnginePaginationResult<
											ScopedRelationRow<
												RelationRow<
													Tables,
													D,
													Extract<Target, keyof Tables>,
													S[K] extends true ? {} : S[K],
													Tail<Level>
												>,
												TargetScope,
												Discriminator<Tables[Extract<Target, keyof Tables>]>
											>
										>
								: never
							: never
					})
	: never
export type RelationRow<
	Tables extends RelationTables,
	D extends RelationDeclarations,
	T extends keyof Tables,
	S,
	Level extends readonly 1[] = Depth,
> = ComposeRelationRow<Tables, D, T, S, Level, PublicRow<Tables[T]>>
export type RelationQueryRow<
	Tables extends RelationTables,
	D extends RelationDeclarations,
	T extends keyof Tables,
	S,
	Scope extends string = never,
> = ScopedRelationRow<RelationRow<Tables, D, T, S>, Scope, Discriminator<Tables[T]>>
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
	): z.ZodType<EnginePaginationResult<RelationRow<Tables, D, T, S>>>
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
	readonly variant?: { readonly discriminator: string; readonly tags: readonly string[] }
	readonly indexes: readonly { readonly name: string; readonly fields: readonly string[] }[]
}
interface TableMetadata {
	fields: Record<string, GenericValidator>
	indexes: { name: string; fields: string[] }[]
	dto: z.ZodObject | z.ZodDiscriminatedUnion<any, string>
	branches?: {
		discriminator: string
		options: Record<string, { fields: Record<string, GenericValidator>; dto: z.ZodObject }>
	}
	allFields: ReadonlySet<string>
	dtoRecipe: DtoRecipe
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
		nativeTables: Readonly<Record<string, TableDefinition>>
		streamSchema: ReturnType<typeof defineSchema>
	}
>()
const refs = new WeakMap<AnyField, GenericValidator>()
const memberRefs = new WeakMap<AnyField, RelationMember>()
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
	declare: (
		r: RelationBuilder<Tables>,
		branch: BranchBuilder<Tables>,
	) => D & ExactDeclarations<Tables, D>,
): RelationRegistry<Tables, D> {
	const metadata: Record<string, TableMetadata> = {}
	const nativeTables: Record<string, TableDefinition> = {}
	const ownRefs = new Set<AnyField>()
	const branchRefs = new Map<string, Record<string, AnyField>>()
	const fields: Record<string, Record<string, AnyField>> = {}
	const one: Record<string, (spec: { from: Leg; to: Leg }) => AnyEdge> = {}
	const many: Record<string, (spec: { from: Leg; to: Leg }) => AnyEdge> = {}
	for (const [name, table] of Object.entries(tables)) {
		if (
			table.tableName !== name ||
			['one', 'many', '__proto__', 'constructor', 'prototype'].includes(name)
		)
			throw new Error(`Invalid relation table "${name}"`)
		// Registration-only preflight rejects accessors before native export or DTO
		// conversion. Stored parsers and their default/pipe callbacks are never run.
		const nativeDescriptor = Object.getOwnPropertyDescriptor(table, 'table')
		if (!nativeDescriptor || !('value' in nativeDescriptor))
			throw new Error('Unsupported native table accessor')
		const nativeTable: TableDefinition = nativeDescriptor.value
		preflightNative(nativeTable)
		preflightSchema(table.schema, 'stored')
		preflightSchema(table.publicDto, 'dto')
		const sourceDto = table.dto(true)
		if (!(sourceDto instanceof z.ZodObject) && !(sourceDto instanceof z.ZodDiscriminatedUnion))
			throw new Error('Expected object or discriminated union DTO')
		preflightSchema(sourceDto, 'dto')
		const dtoRecipe = captureDto(sourceDto)
		const dto = materializeDto(dtoRecipe)
		if (!(dto instanceof z.ZodObject) && !(dto instanceof z.ZodDiscriminatedUnion))
			throw new Error('Expected object or discriminated union DTO')
		const exported = nativeTableExport(nativeTable)
		assertNativeValidation(exported.documentType)
		const normalized = normalizeTable(name, table.schema, dto, exported.documentType)
		const indexes = indexExport
			.parse(exported)
			.indexes.map((index) => ({ name: index.indexDescriptor, fields: [...index.fields] }))
			.sort((a, b) => a.name.localeCompare(b.name))
		assertNativeValidation(nativeJson(zodToConvex(dto)))
		nativeTables[name] = nativeTable
		metadata[name] = { ...normalized, indexes, dto, dtoRecipe }
		const makeReferences = (
			validators: Record<string, GenericValidator>,
			guard?: RelationGuard,
		) => {
			const tableRefs: Record<string, AnyField> = Object.create(null)
			function makeReference(
				field: string,
				validator: GenericValidator,
				member?: RelationMember,
			): AnyField {
				const ref: AnyField = {
					[fieldBrand]: undefined,
					table: name,
					field,
					guard,
					forTable(table: string) {
						if (guard) throw new Error('forTable on branch-scoped fields is unsupported')
						const members = nativeIdMembers(validator)
						if (!members?.includes(table)) throw new Error('Invalid native ID member selection')
						if (!Object.hasOwn(metadata, table))
							throw new Error('Native ID member table is not registered')
						const selected = hasNull(validator) ? v.union(v.id(table), v.null()) : v.id(table)
						return makeReference(
							field,
							validator.isOptional === 'optional' ? v.optional(selected) : selected,
							Object.freeze({ table }),
						)
					},
					through<J extends AnyField>(junction: J): ThroughReference<string, string, any, J, any> {
						if (member || memberRefs.has(junction))
							throw new Error('forTable with through is unsupported')
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
				if (member) memberRefs.set(ref, member)
				ownRefs.add(ref)
				return Object.freeze(ref)
			}
			for (const [field, validator] of Object.entries(validators))
				tableRefs[field] = makeReference(field, validator)
			return Object.freeze(tableRefs)
		}
		fields[name] = makeReferences(normalized.fields)
		if (normalized.branches)
			for (const [tag, branch] of Object.entries(normalized.branches.options))
				branchRefs.set(
					JSON.stringify([name, tag]),
					makeReferences(
						branch.fields,
						Object.freeze({ discriminator: normalized.branches.discriminator, tag }),
					),
				)
		one[name] = (spec) => makeEdge(name, 'one', spec, ownRefs)
		many[name] = (spec) => makeEdge(name, 'many', spec, ownRefs)
	}
	// SAFETY: every native field has a branded reference; mapped builders retain the literal names.
	const builder = Object.freeze({
		...fields,
		one: Object.freeze(one),
		many: Object.freeze(many),
	}) as RelationBuilder<Tables>
	// SAFETY: branch references are created only for validated table/tag pairs and retain literal native field types.
	const branch = ((table: string, tag: string) => {
		const result = branchRefs.get(JSON.stringify([table, tag]))
		if (!result) throw new Error(`Unknown variant scope "${table}.${tag}"`)
		return result
	}) as BranchBuilder<Tables>
	const supplied = declare(builder, branch)
	const declarations: RelationDeclarations = Object.fromEntries(
		Object.entries(supplied).map(([name, edges]) => [name, Object.freeze({ ...edges })]),
	)
	Object.freeze(declarations)
	for (const [source, edges] of Object.entries(declarations)) {
		if (!Object.hasOwn(metadata, source)) throw new Error(`Unknown source table "${source}"`)
		for (const [name, edge] of Object.entries(edges)) {
			if (
				metadata[source].allFields.has(name) ||
				(metadata[source].branches && ['variant', 'variants'].includes(name)) ||
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
	for (const table of Object.keys(metadata))
		helpers[table] = {
			paginationOpts(selection: SelectionMask): z.ZodType {
				assertSelection(selection)
				return materializeDto(paginationRecipe).extend({
					filters: relationFilterSchema(filterGrammar(internal, table, selection)).optional(),
					order: z.enum(['asc', 'desc']).optional(),
				})
			},
			pageDto(selection: SelectionMask): z.ZodType {
				assertSelection(selection)
				return paginated(rowSchema(internal, table, selection)).result
			},
		}

	// Stable, collision-free canonical metadata encoding. It is an identity, not a secret/hash.
	const identity = JSON.stringify([
		2,
		Object.entries(metadata)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, data]) => [
				name,
				Object.entries(data.fields)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([field, validator]) => [field, validator.isOptional, nativeJson(validator)]),
				data.branches
					? [
							data.branches.discriminator,
							Object.entries(data.branches.options)
								.sort(([a], [b]) => a.localeCompare(b))
								.map(([tag, branch]) => [
									tag,
									Object.entries(branch.fields)
										.sort(([a], [b]) => a.localeCompare(b))
										.map(([field, validator]) => [
											field,
											validator.isOptional,
											nativeJson(validator),
										]),
								]),
						]
					: null,
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
	// convex-helpers reads schema.tables[table].indexes live. Supply a genuine
	// private Convex schema whose only purpose is stable stream index metadata.
	const streamTables: Record<string, TableDefinition> = {}
	for (const [name, data] of Object.entries(metadata)) {
		const table: TableDefinition = defineTable({})
		for (const index of data.indexes) {
			const [first, ...rest] = index.fields
			if (first === undefined) throw new Error('Invalid empty active index')
			table.index(index.name, [first, ...rest])
		}
		const indexes = Object.getOwnPropertyDescriptor(table, 'indexes')!.value
		for (const index of indexes) {
			Object.freeze(index.fields)
			Object.freeze(index)
		}
		Object.freeze(indexes)
		Object.freeze(table)
		streamTables[name] = table
	}
	executorRegistries.set(registry, {
		internal,
		nativeTables: Object.freeze(nativeTables),
		streamSchema: defineSchema(Object.freeze(streamTables)),
	})
	return registry
}

/** Internal owned executor bridge. Source ownership is checked once by each engine. */
export function getRelationExecutor(registry: RelationRegistryIdentity) {
	const owned = executorRegistries.get(registry)
	if (!owned) throw new Error('Unknown relation registry')
	const assertSchema = (tables: Readonly<Record<string, TableDefinition>>) => {
		const names = Object.keys(owned.nativeTables)
		if (
			names.length !== Reflect.ownKeys(tables).length ||
			names.some((name) => {
				const descriptor = Object.getOwnPropertyDescriptor(tables, name)
				return (
					!descriptor || !('value' in descriptor) || descriptor.value !== owned.nativeTables[name]
				)
			})
		)
			throw new Error('Native schema/table ownership disagrees with relation registry')
	}
	const branchValidators = new WeakMap<
		object,
		{ validator: z.ZodType; fieldKeys: readonly string[] }
	>()
	const projectionKeys = new WeakMap<z.ZodObject, readonly string[]>()
	const scalarFields = new Map<string, FieldSchemas>()
	const grammars = new Map<string, FilterGrammar>()
	const filterNodes = new WeakMap<FilterGrammar, Map<number, z.ZodObject>>()
	function validateDocument(
		table: string,
		row: Record<string, import('convex/values').Value>,
	): void {
		const data = owned!.internal.metadata[table]
		if (!data) throw new Error('Unknown query table')
		if (!data.branches) return
		const tag = row[data.branches.discriminator]
		const branch =
			// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Native discriminator admission precedes the captured branch parser.
			typeof tag === 'string' && Object.hasOwn(data.branches.options, tag)
				? data.branches.options[tag]
				: undefined
		if (!branch) throw new Error('Invalid variant document')
		let cached = branchValidators.get(branch)
		const fieldKeys = cached?.fieldKeys ?? Object.keys(branch.fields)
		const entries: [string, import('convex/values').Value | undefined][] = []
		// Snapshot ownership before reading getters, as filter().map() did.
		for (const key of fieldKeys) if (Object.hasOwn(row, key)) entries.push([key, undefined])
		for (const entry of entries) entry[1] = row[entry[0]]
		const values = Object.fromEntries(entries)
		if (!cached) {
			cached = { validator: convexToZod(v.object(branch.fields)), fieldKeys }
			branchValidators.set(branch, cached)
		}
		cached.validator.parse(values)
	}
	return Object.freeze({
		streamSchema: owned.streamSchema,
		validateDocument,
		assertSchema,
		pagination(table: string) {
			const internal = owned.internal
			function grammar(name: string, depth: number, tag?: string): FilterGrammar {
				const grammarKey = JSON.stringify([name, depth, tag ?? null])
				const cached = grammars.get(grammarKey)
				if (cached) return cached
				const data = internal.metadata[name]
				if (!data) throw new Error('Unknown query table')
				const cacheKey = JSON.stringify([name, tag ?? null])
				let fields = scalarFields.get(cacheKey)
				if (!fields) {
					fields = {}
					for (const [name, validator] of Object.entries(
						tag === undefined ? data.fields : data.branches!.options[tag].fields,
					)) {
						// Unsupported stored containers are not scalar-queryable. No validators
						// are reconstructed from JSON; these are the actual native validators.
						if (scalarValidator(validator))
							fields[name] = scalarPredicateSchema(validator).optional()
					}
					scalarFields.set(cacheKey, fields)
				}
				const result: FilterGrammar = {
					fields,
					variants:
						data.branches && tag === undefined && depth < 4
							? {
									discriminator: data.branches.discriminator,
									options: Object.fromEntries(
										Object.keys(data.branches.options).map((tag) => [
											tag,
											grammar(name, depth + 1, tag),
										]),
									),
								}
							: undefined,
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
				grammars.set(grammarKey, result)
				return result
			}
			return materializeDto(paginationRecipe).extend({
				filters: relationFilterSchema(grammar(table, 0), filterNodes).optional(),
				order: z.enum(['asc', 'desc']).optional(),
			})
		},
		select(table: string, selection: SelectionMask) {
			assertSelection(selection)
			function visit(table: string, selected: SelectionMask, depth: number): void {
				if (!Object.hasOwn(owned!.internal.metadata, table)) throw new Error('Unknown query table')
				for (const [name, mask] of Object.entries(selected)) {
					const edge = owned!.internal.declarations[table]?.[name]
					if (!edge || depth >= 4)
						throw new Error(`Unknown or too deep relation "${table}.${name}"`)
					if (mask !== true) visit(edge.target, mask, depth + 1)
				}
			}
			visit(table, selection, 0)
		},
		project(
			table: string,
			row: Record<string, import('convex/values').Value>,
			eligible: () => boolean,
		) {
			if (!eligible()) return null
			const data = owned.internal.metadata[table]
			if (!data) throw new Error('Unknown query table')
			const branch = data.branches
				? data.branches.options[String(row[data.branches.discriminator])]
				: undefined
			if (data.branches && !branch) throw new Error('Invalid variant document')
			const dto = branch?.dto ?? data.dto
			if (!(dto instanceof z.ZodObject)) throw new Error('Invalid variant DTO')
			validateDocument(table, row)
			let keys = projectionKeys.get(dto)
			if (!keys) {
				keys = Object.keys(dto.shape)
				projectionKeys.set(dto, keys)
			}
			// The strict DTO remains the authority. Pick its fields before parsing,
			// matching table projection without spreading any storage-only fields.
			return dto.parse(
				Object.fromEntries(
					keys.filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]]),
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
		sourceGuard: base(spec.from).guard,
		targetGuard: base(spec.to).guard,
		junctionGuard: junctionGuard(spec.from, spec.to),
		sourceMember: memberRefs.get(base(spec.from)),
		targetMember: memberRefs.get(base(spec.to)),
	})
	edgeRefs.add(result)
	return result
}
function junctionGuard(from: Leg, to: Leg): RelationGuard | undefined {
	const left = 'base' in from ? from.junction.guard : undefined
	const right = 'base' in to ? to.junction.guard : undefined
	if (left && right && (left.discriminator !== right.discriminator || left.tag !== right.tag))
		throw new Error('Contradictory junction scopes')
	return left ?? right
}
function nativeIdMembers(validator: GenericValidator): string[] | null {
	if (validator.kind === 'id') return [validator.tableName]
	if (validator.kind === 'null') return []
	if (validator.kind !== 'union') return null
	const members = validator.members.map(nativeIdMembers)
	return members.some((member) => member === null)
		? null
		: [...new Set(members.flatMap((member) => member!))].sort()
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
		requireIndex(metadata, from.junction.table, from.junction.field, edge.junctionGuard)
		requireIndex(metadata, edge.target, to.base.field, edge.targetGuard)
		return
	}
	if (!compatible(refs.get(base(from))!, refs.get(base(to))!))
		throw new Error('Incompatible relation field types')
	requireIndex(metadata, edge.target, base(to).field, edge.targetGuard)
}
function requireIndex(
	metadata: Record<string, TableMetadata>,
	table: string,
	field: string,
	guard?: RelationGuard,
): void {
	if (
		field !== '_id' &&
		!metadata[table].indexes.some((index) => {
			const position = index.fields.indexOf(field)
			return (
				position >= 0 &&
				index.fields.slice(0, position).every((key) => key === guard?.discriminator)
			)
		})
	)
		throw new Error(`No active index begins with or has a guarded prefix for "${table}.${field}"`)
}
function serializeLeg(leg: Leg): unknown[] {
	return 'base' in leg
		? [
				leg.base.table,
				leg.base.field,
				leg.base.guard ?? null,
				leg.junction.table,
				leg.junction.field,
				leg.junction.guard ?? null,
			]
		: memberRefs.has(leg)
			? [leg.table, leg.field, leg.guard ?? null, memberRefs.get(leg)]
			: [leg.table, leg.field, leg.guard ?? null]
}
function filterGrammar(
	registry: RegistryMetadata,
	table: string,
	selection: SelectionMask,
	depth: number = 0,
	tag?: string,
): FilterGrammar {
	const fields: FieldSchemas = {}
	const relations: FilterGrammar['relations'] = {}
	const data = registry.metadata[table]
	const variants: Record<string, FilterGrammar> = {}
	for (const [key, mask] of Object.entries(selection)) {
		if (key === 'variants' && mask !== true && data.branches && tag === undefined) {
			if (depth >= 4) throw new Error('Invalid variant selection')
			for (const [tag, selected] of Object.entries(mask)) {
				if (!Object.hasOwn(data.branches.options, tag) || selected === true)
					throw new Error('Unknown variant filter selection')
				const common = Object.fromEntries(
					Object.entries(selection).filter(([key]) => key !== 'variants'),
				)
				variants[tag] = filterGrammar(registry, table, { ...common, ...selected }, depth + 1, tag)
			}
			continue
		}
		const validator = (tag === undefined ? data.fields : data.branches!.options[tag].fields)[key]
		const edge = registry.declarations[table]?.[key]
		if (mask === true && validator) fields[key] = scalarPredicateSchema(validator).optional()
		else if (mask !== true && edge && depth < 4)
			relations[key] = {
				cardinality: edge.cardinality,
				target: filterGrammar(registry, edge.target, mask, depth + 1),
			}
		else throw new Error(`Invalid relation filter selection "${table}.${key}"`)
	}
	return {
		fields,
		relations,
		variants:
			data.branches && tag === undefined
				? { discriminator: data.branches.discriminator, options: variants }
				: undefined,
	}
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
		let target =
			mask === true
				? materializeDto(registry.metadata[edge.target].dtoRecipe)
				: rowSchema(registry, edge.target, mask, depth + 1)
		if (edge.targetGuard) {
			if (!(target instanceof z.ZodDiscriminatedUnion)) throw new Error('Invalid target scope')
			target = target.options
				.filter((option): option is z.ZodObject => option instanceof z.ZodObject)
				.find(
					(option: z.ZodObject) =>
						option.shape[edge.targetGuard!.discriminator] instanceof z.ZodLiteral &&
						option.shape[edge.targetGuard!.discriminator].value === edge.targetGuard!.tag,
				)!
		}
		relationFields[name] = edge.cardinality === 'one' ? target.nullable() : paginated(target).result
	}
	const data = registry.metadata[table]
	const dto = materializeDto(data.dtoRecipe)
	function compose(dto: z.ZodObject, tag?: string) {
		const selected = { ...relationFields }
		for (const name of Object.keys(selected)) {
			const edge = registry.declarations[table][name]
			if (edge.sourceGuard && tag !== edge.sourceGuard.tag && edge.cardinality === 'one')
				selected[name] = z.null()
		}
		return dto.extend(selected).strict()
	}
	if (data.branches) {
		if (!(dto instanceof z.ZodDiscriminatedUnion)) throw new Error('Invalid variant DTO')
		const options = dto.options.map((option) => {
			if (!(option instanceof z.ZodObject)) throw new Error('Invalid variant DTO')
			const tag = option.shape[data.branches!.discriminator]
			if (!(tag instanceof z.ZodLiteral)) throw new Error('Invalid variant tag')
			return compose(option, String(tag.value))
		})
		return z.discriminatedUnion(data.branches.discriminator, [options[0], ...options.slice(1)])
	}
	if (!(dto instanceof z.ZodObject)) throw new Error('Expected object DTO')
	return compose(dto)
}

function normalizeTable(
	name: string,
	schema: RelationTable['schema'],
	dto: z.ZodObject | z.ZodDiscriminatedUnion<any, string>,
	document: ValidatorJSON,
): Pick<TableMetadata, 'fields' | 'branches' | 'allFields'> {
	if (schema instanceof z.ZodObject && dto instanceof z.ZodObject) {
		const fields = zodToConvex(schema).fields
		assertStoredDocument(name, fields, document)
		return { fields, allFields: new Set(Object.keys(fields)) }
	}
	if (!(schema instanceof z.ZodDiscriminatedUnion) || !(dto instanceof z.ZodDiscriminatedUnion))
		throw new Error(`Expected matching discriminated union boundaries "${name}"`)
	const discriminator = schema._zod.def.discriminator
	if (dto._zod.def.discriminator !== discriminator) throw new Error('DTO discriminator mismatch')
	function options(union: z.ZodDiscriminatedUnion<any, string>): Record<string, z.ZodObject> {
		const result: Record<string, z.ZodObject> = Object.create(null)
		for (const option of union.options) {
			if (!(option instanceof z.ZodObject)) throw new Error('Variant branches must be objects')
			const tag = option.shape[discriminator]
			if (!(tag instanceof z.ZodLiteral) || tag.values.size !== 1)
				throw new Error('Variant tags must be unique required string literals')
			const literal = z.string().safeParse(tag.value)
			if (!literal.success || Object.hasOwn(result, literal.data))
				throw new Error('Variant tags must be unique required string literals')
			result[literal.data] = option
		}
		if (Object.keys(result).length === 0) throw new Error('Expected at least one variant branch')
		return result
	}
	const documents = options(schema),
		dtos = options(dto)
	if (Object.keys(documents).sort().join('\0') !== Object.keys(dtos).sort().join('\0'))
		throw new Error('DTO variant tags mismatch')
	const branches: NonNullable<TableMetadata['branches']> = {
		discriminator,
		options: Object.create(null),
	}
	const stored: GenericValidator[] = []
	for (const [tag, object] of Object.entries(documents)) {
		const fields = zodToConvex(object).fields
		const { _id, _creationTime, ...storage } = fields
		assertStoredDocument(name, fields, nativeJson(v.object(storage)))
		stored.push(v.object(storage))
		branches.options[tag] = { fields, dto: dtos[tag] }
	}
	if (canonicalNative(document) !== canonicalNative(nativeJson(v.union(...stored))))
		throw new Error(`Native stored document disagrees with boundary "${name}"`)
	const members = Object.values(branches.options).map((branch) => branch.fields)
	const fields: Record<string, GenericValidator> = {}
	for (const key of Object.keys(members[0])) {
		if (!members.every((member) => Object.hasOwn(member, key))) continue
		if (
			key !== discriminator &&
			!members.every((member) => commonCompatible(member[key], members[0][key]))
		)
			continue
		const validators = members.map((member) => member[key])
		const union = v.union(...validators)
		fields[key] = validators.some((validator) => validator.isOptional === 'optional')
			? v.optional(union)
			: union
	}
	return { fields, branches, allFields: new Set(members.flatMap((member) => Object.keys(member))) }
}
function commonCompatible(left: GenericValidator, right: GenericValidator): boolean {
	try {
		return compatible(left, right)
	} catch {
		return canonicalNative(nativeJson(left)) === canonicalNative(nativeJson(right))
	}
}

interface NativeTableExport {
	indexes: { indexDescriptor: string; fields: string[] }[]
	documentType: ValidatorJSON
}
// Capture the installed peer's prototypes before accepting caller-owned instances.
// Native json getters are trusted only on these prototypes; own accessors and
// custom prototypes fail closed without evaluating them.
const nativePrototypes = new Map<object, PropertyDescriptorMap>()
for (const sample of [
	defineTable(v.object({})),
	v.id('sample'),
	v.null(),
	v.number(),
	v.int64(),
	v.commitTs(),
	v.boolean(),
	v.string(),
	v.bytes(),
	v.any(),
	v.object({}),
	v.literal('sample'),
	v.array(v.string()),
	v.record(v.string(), v.string()),
	v.union(v.string(), v.null()),
]) {
	let prototype = Object.getPrototypeOf(sample)
	while (prototype && prototype !== Object.prototype) {
		if (!nativePrototypes.has(prototype))
			nativePrototypes.set(prototype, Object.getOwnPropertyDescriptors(prototype))
		prototype = Object.getPrototypeOf(prototype)
	}
}

/** Registration-only descriptor preflight; caller accessors are never invoked. */
function preflightNative(table: TableDefinition): void {
	const seen = new Set<object>()
	const active = new Set<object>()
	// oxlint-disable-next-line anti-slop/no-object-parameters -- This descriptor-only boundary admits arbitrary native graph nodes without invoking them.
	function visit(object: object, depth: number, trusted = false): void {
		if (active.has(object)) throw new Error('Unsupported cyclic native schema')
		if (seen.has(object)) return
		if (depth > 64 || seen.size >= 8192) throw new Error('Native schema graph budget exceeded')
		seen.add(object)
		active.add(object)
		const prototype = Object.getPrototypeOf(object)
		const inherited = prototype && nativePrototypes.get(prototype)
		if (
			prototype !== null &&
			prototype !== Object.prototype &&
			prototype !== Array.prototype &&
			!inherited
		)
			throw new Error('Unsupported native schema prototype')
		if (Object.getOwnPropertySymbols(object).length)
			throw new Error('Unsupported native schema symbol')
		const keys = Object.getOwnPropertyNames(object)
		const values = keys.map((key) => Object.getOwnPropertyDescriptor(object, key)!)
		if (
			!trusted &&
			values.some((property) => !('value' in property) || property.value instanceof Function)
		)
			throw new Error('Unsupported native schema accessor or method')
		if (inherited) {
			// Compare the trusted prototype before any native export can invoke it.
			const currentKeys = Object.getOwnPropertyNames(prototype)
			if (
				currentKeys.length !== Object.getOwnPropertyNames(inherited).length ||
				currentKeys.some((key) => {
					const current = Object.getOwnPropertyDescriptor(prototype, key)!
					const before = Object.getOwnPropertyDescriptor(inherited, key)?.value
					return (
						!before ||
						!Object.is(current.value, before.value) ||
						current.get !== before.get ||
						current.set !== before.set
					)
				})
			)
				throw new Error('Unsupported native schema prototype mutation')
			visit(prototype, depth + 1, true)
		}
		if (!trusted)
			for (const property of values) {
				if (property.value !== null && Object(property.value) === property.value)
					visit(property.value, depth + 1)
			}
		active.delete(object)
	}
	visit(table, 0)
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

// Stored schemas already passed the native input boundary. Track their graph
// independently of public DTO admissibility, without running any stored parser.
const builtinDefaultGetter = Function.prototype.toString.call(
	Object.getOwnPropertyDescriptor(z.string().default('')._zod.def, 'defaultValue')!.get!,
)
const builtinPrefaultGetter = Function.prototype.toString.call(
	Object.getOwnPropertyDescriptor(z.string().prefault('')._zod.def, 'defaultValue')!.get!,
)

/** Registration-only admissibility traversal; never runs a stored parser. */
function preflightSchema(dto: z.ZodType, boundary: 'dto' | 'stored'): void {
	const fallbackDefinitions = new Set<object>()
	const seen = new Set<object>()
	const active = new Set<object>()
	const objectDefinitions = new Set<object>()
	// oxlint-disable-next-line anti-slop/no-object-parameters -- Registration must inspect descriptors before trusting a Zod semantic node.
	function visit(value: object, depth: number): void {
		if (active.has(value)) throw new Error('Unsupported cyclic DTO schema')
		if (seen.has(value)) return
		if (depth > 32 || seen.size >= 4096) throw new Error('DTO schema graph budget exceeded')
		seen.add(value)
		active.add(value)
		try {
			const internals = Object.getOwnPropertyDescriptor(value, '_zod')
			if (internals) {
				if (!('value' in internals)) throw new Error('Unsupported DTO schema accessor')
				const definition = Object.getOwnPropertyDescriptor(internals.value, 'def')
				if (!definition || !('value' in definition))
					throw new Error('Unsupported DTO schema accessor')
			}
			if (value instanceof z.core.$ZodCheck && !(value instanceof z.core.$ZodType)) {
				if (boundary === 'dto' && value._zod.def.check === 'overwrite')
					throw new Error('Unsupported DTO overwrite check')
				visit(value._zod.def, depth + 1)

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
						'custom',
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
						// Admit only the installed fallback accessor without evaluating it.
						fallbackDefinitions.add(def)
					}
				}
				if (value instanceof z.ZodUnion) {
					visit(value.options, depth + 1)
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
						objectDefinitions.add(def)
					}
					if (value instanceof z.ZodObject) {
						const publicFields = Object.getOwnPropertyDescriptor(value, 'shape')
						if (publicFields && !('value' in publicFields))
							throw new Error('Unsupported DTO schema accessor')
						visit(value.shape, depth + 1)
					}
				}
				visit(def, depth + 1)

				return
			}
			const keys = Reflect.ownKeys(value)
			const values = keys.map((key) => Object.getOwnPropertyDescriptor(value, key)!)
			if (
				values.some(
					(property, i) =>
						!('value' in property) &&
						!(objectDefinitions.has(value) && keys[i] === 'shape') &&
						!(fallbackDefinitions.has(value) && keys[i] === 'defaultValue'),
				)
			)
				throw new Error('Unsupported DTO schema accessor')

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
			variant: data.branches
				? Object.freeze({
						discriminator: data.branches.discriminator,
						tags: Object.freeze(Object.keys(data.branches.options)),
					})
				: undefined,
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
