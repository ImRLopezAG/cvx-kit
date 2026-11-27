/**
 * cvx-kit 2 tables: one plain object of `k` fields per entity, masked into every boundary it crosses
 * (storage, insert, update, command, public DTO, tool input). Nothing is derived at declaration: each
 * boundary, and the native `defineTable(...)` result, is built when it is first read and then reused.
 */
import {
	defineTable,
	type GenericDocument,
	type PaginationResult,
	type TableDefinition,
} from 'convex/server'
import type { GenericId, GenericValidator, Validator, Value } from 'convex/values'
import {
	k,
	KValidationError,
	type KDiscriminatedUnion,
	type KFields,
	type KId,
	type KIssue,
	type KNumber,
	type KObject,
	type KOptional,
	type KPath,
	type KString,
	type KType,
} from './k'
import { containsTransform } from './k/parse'
import { setOwn } from './k/names'
import type { KDiscriminated } from './k/types'
import {
	convexPaginationOptions,
	paginationSchemaOf,
	type ExactScalarSelection,
	type ScalarPaginationSchema,
	type ScalarSelection,
} from './querying/filters'
import type { PaginationValidatorOptions } from './querying/shared/filters'
import { pageResult } from './querying/shared/page'

export {
	createModule,
	memberName,
	namespace,
	namespaceIndex,
	namespaceName,
	namespacePrefix,
	tablesOf,
	type MemberName,
	type Namespace,
	type NamespaceInfo,
	type NamespaceOptions,
	type NamespacePrefix,
	type NamespaceTag,
	type QualifiedName,
} from './namespace'

/** Lifecycle timestamps every table carries: optional, server-owned, never in insert or command inputs. */
export const TIMESTAMP_FIELDS = ['createdAt', 'updatedAt', 'archivedAt'] as const

export type KTimestampKey = (typeof TIMESTAMP_FIELDS)[number]

export type KTimestampFields = {
	readonly createdAt: KOptional<KNumber>
	readonly updatedAt: KOptional<KNumber>
	readonly archivedAt: KOptional<KNumber>
}

/** The server-owned tenant field `tenantTable` adds. */
export type KTenantFields = { readonly tenant: KString }

export type KSystemFields<Table extends string> = {
	readonly _id: KId<Table>
	readonly _creationTime: KNumber
}

type FieldKey<F> = Extract<keyof F, string>

type ReservedField = '_id' | '_creationTime' | KTimestampKey

type NoFields = Record<never, never>

/** The fields of `KObject.partial()`: every field wrapped optional. */
export type KPartialFields<F extends KFields> = { [K in keyof F]: KOptional<F[K]> }

/**
 * Declared table fields, checked: a reserved or blocked name, or a field holding a `transform` or
 * `pipe`, becomes `never`, so the declaration fails to typecheck at that field (KTD4).
 */
export type KTableFields<F extends KFields, Blocked extends string> = {
	[K in keyof F]: K extends Blocked ? never : true extends F[K]['_t'] ? never : F[K]
}

export type KTableOptions<S extends string, C extends string, P extends string> = {
	/** Excluded from `insertSchema` and `updateSchema`: the server assigns these. */
	readonly serverFields?: readonly S[]
	/** The only fields a command (and its tool input) may carry. */
	readonly commandFields?: readonly C[]
	/** The public DTO allowlist; may name timestamp fields. */
	readonly publicFields?: readonly P[]
}

type ReservedDtoField = '_id' | '_creationTime' | 'tenant' | '__proto__' | KTimestampKey

/** Extension fields for `dto`/`toPublicDto`: new names only, and no transform. */
export type KDtoExtension<Pub extends KFields, E extends KFields> = {
	[K in keyof E]: K extends keyof Pub | ReservedDtoField
		? never
		: true extends E[K]['_t']
			? never
			: E[K]
}

export type KDtoOptions<I extends boolean, E extends KFields> = {
	readonly _id?: I
	readonly extend?: E
}

type KDtoValues<E extends KFields> = keyof E extends never
	? { readonly values?: never }
	: { readonly values: KObject<E>['_input'] }

type KIdField<Table extends string, I extends boolean> = I extends true
	? { readonly _id: KId<Table> }
	: NoFields

type KIdRow<Table extends string, I extends boolean> = I extends true
	? { readonly _id: GenericId<Table> }
	: NoFields

/** `dto` and `toPublicDto`, shared by every object table boundary. */
export interface KDtoBoundary<Table extends string, Row, Pub extends KFields> {
	dto(): KObject<Pub>
	dto<const I extends boolean>(includeId: I): KObject<Pub & KIdField<Table, I>>
	dto<const I extends boolean = false, const E extends KFields = NoFields>(
		options: KDtoOptions<I, E & KDtoExtension<Pub, E>>,
	): KObject<Pub & KIdField<Table, I> & E>
	toPublicDto(row: Row): KObject<Pub>['_output']
	toPublicDto<const I extends boolean>(
		row: Row & KIdRow<Table, I>,
		includeId: I,
	): KObject<Pub & KIdField<Table, I>>['_output']
	toPublicDto<const I extends boolean = false, const E extends KFields = NoFields>(
		row: Row & KIdRow<Table, I>,
		options: KDtoOptions<I, E & KDtoExtension<Pub, E>> & KDtoValues<NoInfer<E>>,
	): KObject<Pub & KIdField<Table, I> & E>['_output']
}

/** What `kTable`, `createTable(...)` and `tenantTable` return. Every schema is a `k` object. */
export interface KTableBoundary<
	Table extends string,
	F extends KFields,
	S extends FieldKey<F>,
	C extends FieldKey<F>,
	P extends FieldKey<F> | KTimestampKey,
> extends KDtoBoundary<
	Table,
	KObject<F & KTimestampFields>['_input'],
	Pick<F & KTimestampFields, P>
> {
	readonly tableName: Table
	/** `defineTable(storage.validator)`, built on first read; chain `.index(...)` on it as usual. */
	readonly table: TableDefinition<KObject<F & KTimestampFields>['validator']>
	/** The stored row without system fields. */
	readonly storage: KObject<F & KTimestampFields>
	/** The stored row with `_id` and `_creationTime`. */
	readonly schema: KObject<F & KTimestampFields & KSystemFields<Table>>
	/** Storage minus timestamps and `serverFields`. */
	readonly insertSchema: KObject<Omit<F, S>>
	/** `insertSchema.partial()`: an omitted field stays omitted (no default is filled). */
	readonly updateSchema: KObject<KPartialFields<Omit<F, S>>>
	readonly commandInput: KObject<Pick<F, C>>
	readonly publicDto: KObject<Pick<F & KTimestampFields, P>>
	readonly tools: {
		readonly insert: KObject<Pick<F, C>>
		readonly update: KObject<{
			readonly data: KObject<KPartialFields<Pick<F, C>>>
			readonly id: KId<Table>
		}>
		readonly id: KObject<{ readonly id: KId<Table> }>
	}
	insert(): KObject<Omit<F, S>>
	insert<const K extends FieldKey<Omit<F, S>>>(...omit: K[]): KObject<Omit<Omit<F, S>, K>>
	update(): KObject<KPartialFields<Omit<F, S>>>
	update<const K extends FieldKey<Omit<F, S>>>(
		...omit: K[]
	): KObject<Omit<KPartialFields<Omit<F, S>>, K>>
	/**
	 * Pagination options with bounded scalar filters over the selected document fields (stored,
	 * timestamp and system fields). `{ validator: 'compact' }` exports a smaller native validator; the
	 * kit then validates the filter fully itself. Each call builds a new boundary lazily.
	 */
	paginationOpts<
		const Selection extends ScalarSelection<F & KTimestampFields & KSystemFields<Table>>,
	>(
		selection: ExactScalarSelection<F & KTimestampFields & KSystemFields<Table>, Selection>,
		options?: PaginationValidatorOptions,
	): ScalarPaginationSchema<F & KTimestampFields & KSystemFields<Table>, Selection>
}

/** Completeness of the requested page, independently of global isDone exhaustion. */
export type PageCompleteness =
	| 'complete'
	| 'row-budget'
	| 'byte-budget'
	| 'native-limit'
	| 'result-cap'

export type EnginePaginationResult<Row> = PaginationResult<Row> & {
	paginationMode?: 'native-search'
	completeness?: PageCompleteness
}

/**
 * Cursor-pagination boundary schemas for a page of `dto`: `args.paginationOpts` is Convex's own
 * `paginationOptsValidator`, `result` the page shape. The result is not strict on parse (Convex may
 * attach engine fields such as splitCursor and pageStatus); the page items are validated by `dto`.
 * Under row-level security, pages may be SHORTER than numItems when rules reject rows mid-page;
 * cursors remain correct. Nothing is built until a validator is read.
 */
export function paginated<Dto extends KType>(dto: Dto) {
	return {
		args: { paginationOpts: convexPaginationOptions() },
		result: pageResult(dto),
	}
}

/** The function `createTable(shared)` returns: `kTable` with the shared fields ahead of the table's own. */
export type KTableFactory<Shared extends KFields> = <
	const Table extends string,
	F extends KFields,
	const S extends FieldKey<Shared & F> = never,
	const C extends Exclude<FieldKey<Shared & F>, S> = never,
	const P extends FieldKey<Shared & F> | KTimestampKey = never,
>(
	tableName: Table,
	fields: F & KTableFields<F, ReservedField | SharedKey<Shared>>,
	options?: KTableOptions<S, C, P>,
) => KTableBoundary<Table, Shared & F, S, C, P>

type SharedKey<Shared> = string extends keyof Shared ? never : FieldKey<Shared>

/** Defines one table from a plain object of `k` fields and derives every boundary on first read. */
export function kTable<
	const Table extends string,
	F extends KFields,
	const S extends FieldKey<F> = never,
	const C extends Exclude<FieldKey<F>, S> = never,
	const P extends FieldKey<F> | KTimestampKey = never,
>(
	tableName: Table,
	fields: F & KTableFields<F, ReservedField>,
	options: KTableOptions<S, C, P> = {},
): KTableBoundary<Table, F, S, C, P> {
	assertOwnedFields(fields, OWNED_RESERVED)
	return tableBoundary(tableName, fields, options)
}

/** Reuses ordinary fields across tables; table-specific fields cannot redeclare a shared name. */
export function createTable<Shared extends KFields>(
	shared: Shared & KTableFields<Shared, ReservedField>,
): KTableFactory<Shared> {
	assertOwnedFields(shared, OWNED_RESERVED)
	assertNoTransforms('createTable', shared)
	function customTable(tableName: string, fields: KFields, options: RuntimeTableOptions = {}) {
		for (const key of Object.keys(fields)) {
			if (Object.hasOwn(shared, key))
				throw new Error(`Duplicate shared table field "${key}" on table "${tableName}"`)
		}
		assertOwnedFields(fields, OWNED_RESERVED)
		return tableBoundary(tableName, { ...shared, ...fields }, options)
	}
	// SAFETY: customTable runs the checks KTableFactory states and returns tableBoundary's record, which KTableBoundary describes.
	return customTable as KTableFactory<Shared>
}

/**
 * A table whose rows are tenant-owned: adds a required, server-owned `tenant` string (`min(1)`),
 * excluded from insert, update and command inputs, and public only when listed in `publicFields`.
 */
export function tenantTable<
	const Table extends string,
	F extends KFields,
	const S extends FieldKey<F> = never,
	const C extends Exclude<FieldKey<F>, S> = never,
	const P extends FieldKey<F> | 'tenant' | KTimestampKey = never,
>(
	tableName: Table,
	fields: F & KTableFields<F, ReservedField | 'tenant'>,
	options: KTableOptions<S, C, P> = {},
): KTableBoundary<Table, F & KTenantFields, S | 'tenant', C, P> {
	assertOwnedFields(fields, ['tenant', ...OWNED_RESERVED])
	return tableBoundary(
		tableName,
		{ ...fields, ...tenantFields },
		{ ...options, serverFields: [...(options.serverFields ?? []), 'tenant'] },
	)
}

type BranchFields<B> = B extends KObject<infer F> ? F : never

type BranchTag<B, Key extends string> = B extends {
	readonly _output: { readonly [P in Key]: infer Tag }
}
	? Extract<Tag, string>
	: never

type BranchKeys<B, Key extends string> = Exclude<FieldKey<BranchFields<B>>, Key>

type BranchByTag<M extends readonly KType[], Key extends string, Tag> = Extract<
	M[number],
	{ readonly _output: { readonly [P in Key]: Tag } }
>

export type KVariantConfig<Keys extends string> = {
	readonly serverFields?: readonly Keys[]
	readonly commandFields?: readonly Keys[]
	readonly publicFields?: readonly (Keys | KTimestampKey)[]
}

/** Boundary mode: object branches, one string literal tag each, and one configuration per tag. */
export type KVariantOptions<Key extends string, M extends readonly KType[]> = {
	readonly discriminator: Key
	readonly timestamps?: boolean
	readonly variants: {
		readonly [B in M[number] as BranchTag<B, Key>]: KVariantConfig<BranchKeys<B, Key>>
	}
}

type MaskKeys<Config, Mask extends string> = Config extends {
	readonly [P in Mask]?: readonly (infer Field)[]
}
	? Extract<Field, string>
	: never

type CheckedVariantOptions<
	Key extends string,
	M extends readonly KType[],
	O extends KVariantOptions<Key, M>,
> = {
	readonly variants: {
		readonly [Tag in keyof O['variants']]: Tag extends BranchTag<M[number], Key>
			? {
					readonly commandFields?: readonly Exclude<
						BranchKeys<BranchByTag<M, Key, Tag>, Key>,
						MaskKeys<O['variants'][Tag], 'serverFields'>
					>[]
					readonly publicFields?: readonly (
						| BranchKeys<BranchByTag<M, Key, Tag>, Key>
						| (O extends { readonly timestamps: true } ? KTimestampKey : never)
					)[]
				}
			: never
	}
}

type VariantMode =
	| 'storage'
	| 'document'
	| 'insert'
	| 'update'
	| 'command'
	| 'commandUpdate'
	| 'public'

type VariantTimestamps<O> = O extends { readonly timestamps: true } ? KTimestampFields : NoFields

type VariantConfigOf<O, B, Key extends string> = O extends {
	readonly variants: infer Variants
}
	? Variants[BranchTag<B, Key> & keyof Variants]
	: never

type PickOf<F, K> = Pick<F, Extract<K, keyof F>>

type VariantFields<
	Table extends string,
	Key extends string,
	F extends KFields,
	Config,
	Timestamps extends KFields,
	Mode extends VariantMode,
> = Mode extends 'storage'
	? F & Timestamps
	: Mode extends 'document'
		? F & Timestamps & KSystemFields<Table>
		: Mode extends 'insert'
			? Omit<F, MaskKeys<Config, 'serverFields'>>
			: Mode extends 'update'
				? KPartialFields<Omit<F, Key | MaskKeys<Config, 'serverFields'>>> & PickOf<F, Key>
				: Mode extends 'command'
					? PickOf<F, Key | MaskKeys<Config, 'commandFields'>>
					: Mode extends 'commandUpdate'
						? KPartialFields<PickOf<F, MaskKeys<Config, 'commandFields'>>> & PickOf<F, Key>
						: PickOf<F & Timestamps, Key | MaskKeys<Config, 'publicFields'>>

/** One derived variant boundary: a discriminated union of the per-branch objects for `Mode`. */
export type KVariantUnion<
	Table extends string,
	Key extends string,
	M extends readonly KType[],
	O,
	Mode extends VariantMode,
	I extends boolean = false,
> = KDiscriminatedUnion<
	Key,
	{
		[Index in keyof M]: KObject<
			VariantFields<
				Table,
				Key,
				BranchFields<M[Index]>,
				VariantConfigOf<O, M[Index], Key>,
				VariantTimestamps<O>,
				Mode
			> &
				KIdField<Table, I>
		>
	}
>

/** What the three-argument `kVariantTable` returns. */
export interface KVariantTableBoundary<
	Table extends string,
	Key extends string,
	M extends readonly KType[],
	O,
> {
	readonly tableName: Table
	readonly table: TableDefinition<KVariantUnion<Table, Key, M, O, 'storage'>['validator']>
	readonly storage: KVariantUnion<Table, Key, M, O, 'storage'>
	readonly schema: KVariantUnion<Table, Key, M, O, 'document'>
	readonly insertSchema: KVariantUnion<Table, Key, M, O, 'insert'>
	readonly updateSchema: KVariantUnion<Table, Key, M, O, 'update'>
	readonly commandInput: KVariantUnion<Table, Key, M, O, 'command'>
	readonly publicDto: KVariantUnion<Table, Key, M, O, 'public'>
	readonly tools: {
		readonly id: KObject<{ readonly id: KId<Table> }>
		readonly insert: KVariantUnion<Table, Key, M, O, 'command'>
		readonly update: KObject<{
			readonly id: KId<Table>
			readonly data: KVariantUnion<Table, Key, M, O, 'commandUpdate'>
		}>
	}
	dto(): KVariantUnion<Table, Key, M, O, 'public'>
	dto<const I extends boolean>(includeId: I): KVariantUnion<Table, Key, M, O, 'public', I>
	toPublicDto(
		row: KVariantUnion<Table, Key, M, O, 'storage'>['_input'],
	): KVariantUnion<Table, Key, M, O, 'public'>['_output']
	toPublicDto<const I extends boolean>(
		row: KVariantUnion<Table, Key, M, O, 'storage'>['_input'] & KIdRow<Table, I>,
		includeId: I,
	): KVariantUnion<Table, Key, M, O, 'public', I>['_output']
}

/** What the two-argument (legacy) `kVariantTable` returns: the schema is stored as declared. */
export interface KLegacyVariantTable<Table extends string, Schema extends KType> {
	readonly tableName: Table
	readonly storage: Schema
	readonly insertSchema: Schema
	readonly table: TableDefinition<Schema['validator']>
}

/** Legacy mode stores any `k` schema as declared; the third argument opts into derived boundaries. */
export function kVariantTable<const Table extends string, Schema extends KType>(
	tableName: Table,
	storage: Schema & (true extends Schema['_t'] ? never : KType),
): KLegacyVariantTable<Table, Schema>
export function kVariantTable<
	const Table extends string,
	Key extends string,
	M extends readonly KType[],
	const O extends KVariantOptions<Key, M>,
>(
	tableName: Table,
	storage: KDiscriminatedUnion<Key, M>,
	options: O & CheckedVariantOptions<Key, M, NoInfer<O>>,
): KVariantTableBoundary<Table, Key, M, O>
export function kVariantTable<B>(
	tableName: string,
	storage: KType,
	options?: RuntimeVariantOptions,
): B {
	if (options) return boundaryOf<B>(new VariantBoundaryRecord(tableName, storage, options))
	assertNoTransforms(tableName, { storage })
	return boundaryOf<B>(new LegacyVariantRecord(tableName, storage))
}

type RuntimeTableOptions = {
	readonly serverFields?: readonly string[]
	readonly commandFields?: readonly string[]
	readonly publicFields?: readonly string[]
}

type RuntimeDtoOptions = {
	readonly _id?: boolean
	readonly extend?: KFields
	readonly values?: StoredRow
}

type RuntimeVariantOptions = {
	readonly discriminator: string
	readonly timestamps?: boolean
	readonly variants: Readonly<Record<string, RuntimeTableOptions>>
}

/** A stored row or DTO value as handlers pass it: field name to Convex value. */
interface StoredRow {
	readonly [field: string]: Value | undefined
}

interface ProjectedRow {
	[field: string]: Value | undefined
}

/** Object and union schemas whose fields are only known at runtime. */
type RuntimeObject = KObject<any>

type RuntimeUnion = KDiscriminatedUnion<string, any>

const OWNED_RESERVED: readonly string[] = ['_id', '_creationTime', ...TIMESTAMP_FIELDS]

const RESERVED_DTO_FIELDS: ReadonlySet<string> = new Set([
	'_id',
	'_creationTime',
	'tenant',
	'__proto__',
	...TIMESTAMP_FIELDS,
])

/** Immutable records, so every table shares the same three timestamp field schemas. */
const optionalTimestamp = k.number().optional()

const timestampFields: KTimestampFields = {
	createdAt: optionalTimestamp,
	updatedAt: optionalTimestamp,
	archivedAt: optionalTimestamp,
}

const tenantFields: KTenantFields = { tenant: k.string().min(1) }

const noExtension: KFields = {}

/** Ops that change a value; DTO extensions and variant branches allow validation only. */
const VALUE_CHANGING_OPS: ReadonlySet<string> = new Set([
	'default',
	'trim',
	'lower',
	'upper',
	'overwrite',
	'transform',
	'pipe',
	'catch',
	'strip',
])

const FAIL: unique symbol = Symbol('cvx-kit/table.fail')

/**
 * The runtime of every object table boundary. Each derived schema has its own memo slot, so reading
 * one boundary builds that boundary only; `table` compiles the storage validator on first read.
 */
class TableRecord {
	readonly tableName: string
	readonly #columns: KFields
	readonly #writeKeys: readonly string[]
	readonly #commandKeys: readonly string[]
	readonly #publicKeys: readonly string[]
	#table: TableDefinition | undefined
	#storage: RuntimeObject | undefined
	#schema: RuntimeObject | undefined
	#insert: RuntimeObject | undefined
	#update: RuntimeObject | undefined
	#command: RuntimeObject | undefined
	#public: RuntimeObject | undefined
	#publicWithId: RuntimeObject | undefined
	#tools: TableTools | undefined
	#id: KId<string> | undefined

	constructor(tableName: string, columns: KFields, options: RuntimeTableOptions) {
		this.tableName = tableName
		this.#columns = columns
		const omitted = new Set<string>([...TIMESTAMP_FIELDS, ...(options.serverFields ?? [])])
		this.#writeKeys = Object.keys(columns).filter((key) => !omitted.has(key))
		this.#commandKeys = [...(options.commandFields ?? [])]
		this.#publicKeys = [...(options.publicFields ?? [])]
		Object.defineProperties(this, tableAccessors)
	}

	get table(): TableDefinition {
		return (this.#table ??= defineTable(this.storage.validator))
	}

	get storage(): RuntimeObject {
		return (this.#storage ??= k.strictObject(this.#columns))
	}

	get schema(): RuntimeObject {
		return (this.#schema ??= k.strictObject({
			...this.#columns,
			_id: this.#idField(),
			_creationTime: k.number(),
		}))
	}

	get insertSchema(): RuntimeObject {
		return (this.#insert ??= k.strictObject(pickFields(this.#columns, this.#writeKeys)))
	}

	get updateSchema(): RuntimeObject {
		return (this.#update ??= this.insertSchema.partial())
	}

	get commandInput(): RuntimeObject {
		return (this.#command ??= k.strictObject(pickFields(this.#columns, this.#commandKeys)))
	}

	get publicDto(): RuntimeObject {
		return (this.#public ??= k.strictObject(pickFields(this.#columns, this.#publicKeys)))
	}

	get tools(): TableTools {
		return (this.#tools ??= {
			insert: this.commandInput,
			update: k.strictObject({
				data: k.strictObject(pickFields(this.#columns, this.#commandKeys)).partial(),
				id: this.#idField(),
			}),
			id: k.strictObject({ id: this.#idField() }),
		})
	}

	readonly insert = (...omit: string[]): RuntimeObject =>
		omit.length === 0 ? this.insertSchema : this.insertSchema.omit(...omit)

	readonly update = (...omit: string[]): RuntimeObject =>
		omit.length === 0 ? this.updateSchema : this.updateSchema.omit(...omit)

	readonly dto = (options?: boolean | RuntimeDtoOptions): RuntimeObject => {
		const { includeId, extension } = dtoOptionsOf(options)
		this.#assertExtension(extension)
		const extended = Object.keys(extension).length > 0
		if (!extended && !includeId) return this.publicDto
		if (!extended) return (this.#publicWithId ??= this.publicDto.extend({ _id: this.#idField() }))
		const fields = { ...this.publicDto.shape, ...extension }
		return k.strictObject(includeId ? { ...fields, _id: this.#idField() } : fields)
	}

	readonly paginationOpts = (
		selection: Readonly<Record<string, true>>,
		options?: PaginationValidatorOptions,
	): RuntimeObject => {
		const documentFields: KFields = this.schema.shape
		const validators: Record<string, GenericValidator> = {}
		for (const key of Object.keys(selection))
			if (Object.hasOwn(documentFields, key)) setOwn(validators, key, documentFields[key].validator)
		return paginationSchemaOf(validators, selection, options)
	}

	readonly toPublicDto = (row: StoredRow, options?: boolean | RuntimeDtoOptions): ProjectedRow => {
		const { includeId, extension, values } = dtoOptionsOf(options)
		this.#assertExtension(extension)
		const projected = projectRow(this.publicDto.shape, row, includeId, this.#idField(), true)
		if (extension === noExtension && values === undefined) return projected
		// SAFETY: a parsed k object of Convex-value fields is a Convex object.
		const extra = k.object(extension)['~parseStrict'](values ?? {}) as ProjectedRow
		return Object.assign(projected, extra)
	}

	#idField(): KId<string> {
		return (this.#id ??= k.id(this.tableName))
	}

	#assertExtension(extension: KFields): void {
		if (extension === noExtension) return
		const publicKeys = new Set(this.#publicKeys)
		for (const key of Object.keys(extension)) {
			if (RESERVED_DTO_FIELDS.has(key) || publicKeys.has(key))
				throw new Error(`DTO extension collision for field "${key}" on table "${this.tableName}"`)
			if (!isValuePreserving(extension[key]))
				throw new Error('DTO extensions require supported value-preserving validation schemas')
		}
	}
}

type TableTools = {
	readonly insert: RuntimeObject
	readonly update: RuntimeObject
	readonly id: RuntimeObject
}

class LegacyVariantRecord {
	readonly tableName: string
	readonly storage: KType
	readonly insertSchema: KType
	#table: TableDefinition | undefined

	constructor(tableName: string, storage: KType) {
		this.tableName = tableName
		this.storage = storage
		this.insertSchema = storage
		Object.defineProperties(this, legacyAccessors)
	}

	get table(): TableDefinition {
		// SAFETY: defineTable validates at runtime that the stored validator is an object or union.
		return (this.#table ??= defineTable(this.storage.validator as DocumentValidator))
	}
}

/** What `defineTable` accepts as a document validator: an object or a union of objects. */
type DocumentValidator = Validator<GenericDocument, 'required', string>

/** One branch of a variant boundary; each derived object is built on first read. */
class VariantBranch {
	readonly tag: string
	readonly #discriminator: string
	readonly #tableName: string
	readonly #columns: KFields
	readonly #insertKeys: readonly string[]
	readonly #commandKeys: readonly string[]
	readonly #publicKeys: readonly string[]
	#memo: Partial<Record<VariantMode, RuntimeObject>> = {}

	constructor(
		tag: string,
		discriminator: string,
		tableName: string,
		columns: KFields,
		config: RuntimeTableOptions,
		timestamps: boolean | undefined,
	) {
		this.tag = tag
		this.#discriminator = discriminator
		this.#tableName = tableName
		this.#columns = columns
		const omitted = new Set<string>([
			...(timestamps === false ? [] : TIMESTAMP_FIELDS),
			...(config.serverFields ?? []),
		])
		this.#insertKeys = Object.keys(columns).filter((key) => !omitted.has(key))
		this.#commandKeys = [...(config.commandFields ?? [])]
		this.#publicKeys = [discriminator, ...(config.publicFields ?? [])]
	}

	get public(): RuntimeObject {
		return this.derive('public')
	}

	derive(mode: VariantMode): RuntimeObject {
		return (this.#memo[mode] ??= this.#build(mode))
	}

	#build(mode: VariantMode): RuntimeObject {
		const columns = this.#columns
		const tag = { [this.#discriminator]: columns[this.#discriminator] }
		switch (mode) {
			case 'storage':
				return k.strictObject(columns)
			case 'document':
				return k.strictObject({
					...columns,
					_id: k.id(this.#tableName),
					_creationTime: k.number(),
				})
			case 'insert':
				return k.strictObject(pickFields(columns, this.#insertKeys))
			case 'update':
				return k.strictObject(pickFields(columns, this.#insertKeys)).partial().extend(tag)
			case 'command':
				return k.strictObject(pickFields(columns, [this.#discriminator, ...this.#commandKeys]))
			case 'commandUpdate':
				return k
					.strictObject(pickFields(columns, [this.#discriminator, ...this.#commandKeys]))
					.partial()
					.extend(tag)
			case 'public':
				return k.strictObject(pickFields(columns, this.#publicKeys))
		}
	}
}

/** The runtime of a three-argument `kVariantTable`. */
class VariantBoundaryRecord {
	readonly tableName: string
	readonly #discriminator: string
	readonly #branches: ReadonlyMap<string, VariantBranch>
	#memo: Partial<Record<VariantMode | 'publicWithId', RuntimeUnion>> = {}
	#table: TableDefinition | undefined
	#tools: VariantTools | undefined
	#id: KId<string> | undefined

	constructor(tableName: string, declared: KType, options: RuntimeVariantOptions) {
		this.tableName = tableName
		const discriminator = options.discriminator
		this.#discriminator = discriminator
		const { root, refined } = rootOf(declared)
		if (root.op !== 'discriminatedUnion' || discriminatedOf(root).key !== discriminator)
			throw new Error(
				'Variant boundaries require a discriminated union with the configured discriminator',
			)
		if (refined) throw new Error('Variant boundaries do not support union-level refinements')
		if (OWNED_RESERVED.includes(discriminator))
			throw new Error('Variant discriminator cannot be a reserved field')
		const timestamps = options.timestamps
		const branches = new Map<string, VariantBranch>()
		for (const option of discriminatedOf(root).options) {
			const branch = rootOf(option)
			if (branch.root.op !== 'object') throw new Error('Variant boundaries require object branches')
			if (branch.refined)
				throw new Error('Variant boundaries do not support object-level refinements')
			const fields = fieldsOf(branch.root)
			for (const key of Object.keys(fields)) {
				if (!isValuePreserving(fields[key]))
					throw new Error(
						`Variant boundaries require supported value-preserving field validators (field "${key}")`,
					)
			}
			const tag = literalTagOf(fields[discriminator])
			if (tag === undefined)
				throw new Error('Variant branches require one string literal discriminator')
			if (branches.has(tag)) throw new Error(`Duplicate variant discriminator "${tag}"`)
			if (!Object.hasOwn(options.variants, tag))
				throw new Error(`Missing variant configuration "${tag}"`)
			const config = options.variants[tag]
			assertOwnedFields(fields, timestamps === false ? ['_id', '_creationTime'] : OWNED_RESERVED)
			const columns: KFields = timestamps === true ? { ...fields, ...timestampFields } : fields
			const server = config.serverFields ?? []
			const command = config.commandFields ?? []
			const publicKeys = config.publicFields ?? []
			assertFieldLists(columns, server, command, publicKeys, timestamps !== false)
			for (const mask of [server, command, publicKeys]) {
				if (mask.includes(discriminator))
					throw new Error(
						'The variant discriminator is retained automatically and cannot appear in masks',
					)
			}
			for (const field of command) assertToolField(columns[field])
			branches.set(
				tag,
				new VariantBranch(tag, discriminator, tableName, columns, config, timestamps),
			)
		}
		for (const tag of Object.keys(options.variants)) {
			if (!branches.has(tag)) throw new Error(`Unknown variant configuration "${tag}"`)
		}
		this.#branches = branches
		Object.defineProperties(this, variantAccessors)
	}

	get table(): TableDefinition {
		// SAFETY: the storage union compiles to a union of object validators, which defineTable accepts.
		return (this.#table ??= defineTable(this.storage.validator as DocumentValidator))
	}

	get storage(): RuntimeUnion {
		return this.#union('storage')
	}

	get schema(): RuntimeUnion {
		return this.#union('document')
	}

	get insertSchema(): RuntimeUnion {
		return this.#union('insert')
	}

	get updateSchema(): RuntimeUnion {
		return this.#union('update')
	}

	get commandInput(): RuntimeUnion {
		return this.#union('command')
	}

	get publicDto(): RuntimeUnion {
		return this.#union('public')
	}

	get tools(): VariantTools {
		return (this.#tools ??= {
			id: k.strictObject({ id: this.#idField() }),
			insert: this.commandInput,
			update: k.strictObject({ id: this.#idField(), data: this.#union('commandUpdate') }),
		})
	}

	readonly dto = (includeId = false): RuntimeUnion =>
		includeId ? this.#union('publicWithId') : this.publicDto

	readonly toPublicDto = (row: StoredRow, includeId = false): ProjectedRow => {
		const tag = row[this.#discriminator]
		const branch = this.#branches.get(String(tag))
		if (branch === undefined) throw new Error(`Unknown variant discriminator "${String(tag)}"`)
		return projectRow(branch.public.shape, row, includeId, this.#idField(), false)
	}

	#union(mode: VariantMode | 'publicWithId'): RuntimeUnion {
		const cached = this.#memo[mode]
		if (cached !== undefined) return cached
		const id = this.#idField()
		const options: RuntimeObject[] = []
		for (const branch of this.#branches.values()) {
			options.push(
				mode === 'publicWithId' ? branch.public.extend({ _id: id }) : branch.derive(mode),
			)
		}
		const [first, ...rest] = options
		if (first === undefined) throw new Error('Variant boundaries require at least one branch')
		return (this.#memo[mode] = k.discriminatedUnion(this.#discriminator, [first, ...rest]))
	}

	#idField(): KId<string> {
		return (this.#id ??= k.id(this.tableName))
	}
}

type VariantTools = {
	readonly id: RuntimeObject
	readonly insert: RuntimeUnion
	readonly update: RuntimeObject
}

/**
 * The lazy members of every boundary, as own enumerable accessors that forward to the class getters.
 * An object spread (`{ ...table, table: other }`) then copies them: it reads each one once, so the
 * copy holds the derived schemas, while a boundary that is never spread still builds each on first read.
 * One shared descriptor map per class, so declaring a table adds no per-member closures.
 */
const lazyMembers = [
	'table',
	'storage',
	'schema',
	'insertSchema',
	'updateSchema',
	'commandInput',
	'publicDto',
	'tools',
] as const

function ownAccessors(
	prototype: TableRecord | LegacyVariantRecord | VariantBoundaryRecord,
	names: readonly string[],
): PropertyDescriptorMap {
	const descriptors: PropertyDescriptorMap = {}
	for (const name of names) {
		const getter = Object.getOwnPropertyDescriptor(prototype, name)?.get
		if (getter === undefined) throw new Error(`cvx-kit/table: no lazy member "${name}"`)
		descriptors[name] = { get: getter, enumerable: true, configurable: true }
	}
	return descriptors
}

const tableAccessors = ownAccessors(TableRecord.prototype, lazyMembers)
const legacyAccessors = ownAccessors(LegacyVariantRecord.prototype, ['table'])
const variantAccessors = ownAccessors(VariantBoundaryRecord.prototype, lazyMembers)

function tableBoundary<B>(tableName: string, columns: KFields, options: RuntimeTableOptions): B {
	assertNoTransforms(tableName, columns)
	const stored: KFields = { ...columns, ...timestampFields }
	assertFieldLists(
		stored,
		options.serverFields ?? [],
		options.commandFields ?? [],
		options.publicFields ?? [],
	)
	return boundaryOf<B>(new TableRecord(tableName, stored, options))
}

function boundaryOf<B>(record: TableRecord | LegacyVariantRecord | VariantBoundaryRecord): B {
	// SAFETY: each record class implements every member of the boundary interface its public overload names as B.
	return record as B
}

function assertOwnedFields(fields: KFields, reserved: readonly string[]): void {
	for (const key of reserved) {
		if (Object.hasOwn(fields, key))
			throw new Error(`Reserved table field "${key}" cannot be declared`)
	}
}

function assertNoTransforms(tableName: string, fields: KFields): void {
	for (const key of Object.keys(fields)) {
		if (containsTransform(fields[key]))
			throw new Error(
				`Table field "${key}" on "${tableName}" uses transform or pipe, or catch; table fields must keep their type (use trim, toLowerCase or overwrite to normalise)`,
			)
	}
}

function assertFieldLists(
	fields: KFields,
	server: readonly string[],
	command: readonly string[],
	publicKeys: readonly string[],
	managedTimestamps = true,
): void {
	for (const key of [...server, ...command, ...publicKeys]) {
		if (!Object.hasOwn(fields, key)) throw new Error(`Unknown table field "${key}"`)
	}
	const managed = new Set<string>([...(managedTimestamps ? TIMESTAMP_FIELDS : []), ...server])
	for (const key of command) {
		if (managed.has(key)) throw new Error(`Server-owned field "${key}" cannot be a command input`)
	}
}

function pickFields(fields: KFields, keys: readonly string[]): KFields {
	const out: Record<string, KType> = {}
	for (const key of keys) setOwn(out, key, fields[key])
	return out
}

function dtoOptionsOf(options: boolean | RuntimeDtoOptions | undefined) {
	if (options === undefined || options === true || options === false)
		return { includeId: options === true, extension: noExtension, values: undefined }
	return {
		includeId: options._id === true,
		extension: options.extend ?? noExtension,
		values: options.values,
	}
}

/**
 * The chain's root record, and whether any record above it refines it. A description and `.strict()`
 * do not: a table boundary rejects unknown keys anyway.
 */
function rootOf(schema: KType): RootInfo {
	let current = schema
	let refined = false
	while (current.prev !== null) {
		if (current.op !== 'describe' && current.op !== 'strict') refined = true
		current = schemaOf(current.prev)
	}
	return { root: current, refined }
}

interface RootInfo {
	readonly root: KType
	readonly refined: boolean
}

/** The string tag of a discriminator field that is a bare `k.literal('...')`, else undefined. */
function literalTagOf(field: KType | undefined): string | undefined {
	if (field === undefined) return undefined
	const { root, refined } = rootOf(field)
	if (refined || root.op !== 'literal') return undefined
	return isString(root.arg) ? root.arg : undefined
}

/** Whether a schema only validates: no default, normaliser, transform, pipe or strip, at any depth. */
function isValuePreserving(schema: KType): boolean {
	// The same transform, pipe and catch detection ordinary table fields use, at any depth.
	if (containsTransform(schema)) return false
	let current = schema
	while (current.prev !== null) {
		if (VALUE_CHANGING_OPS.has(current.op)) return false
		current = schemaOf(current.prev)
	}
	return childrenOf(current).every(isValuePreserving)
}

/** Tool inputs become JSON Schema, which cannot represent bigint. */
function assertToolField(schema: KType): void {
	const { root } = rootOf(schema)
	if (root.op === 'int64' || (root.op === 'literal' && isBigint(root.arg)))
		throw new Error(
			'Variant tool command fields cannot contain bigint; JSON Schema cannot represent it',
		)
	for (const child of childrenOf(root)) assertToolField(child)
}

function childrenOf(root: KType): readonly KType[] {
	switch (root.op) {
		case 'object':
			return Object.values(fieldsOf(root))
		case 'array':
			return [schemaOf(root.arg)]
		case 'record':
		case 'union':
			// SAFETY: k.record stores its key and value schemas, and k.union its members, as the root argument.
			return root.arg as readonly KType[]
		case 'discriminatedUnion':
			return discriminatedOf(root).options
		default:
			return []
	}
}

/**
 * Project a stored row onto `fields` and re-check it structurally (R16): only the listed fields are
 * read, a missing default is filled (R17), and a value outside a field's shape, including a nested
 * unknown key, throws. Checks and normalisers are not re-run on stored values (AE3).
 */
function projectRow(
	fields: KFields,
	row: StoredRow,
	includeId: boolean,
	idField: KType,
	keepMissing: boolean,
): ProjectedRow {
	const issues: KIssue[] = []
	const out: ProjectedRow = {}
	for (const key of Object.keys(fields)) {
		const value = project(
			fields[key],
			Object.hasOwn(row, key) ? row[key] : undefined,
			[key],
			issues,
		)
		if (value !== FAIL && (value !== undefined || keepMissing)) setOwn(out, key, value)
	}
	if (includeId) {
		const id = project(idField, row._id, ['_id'], issues)
		if (id !== FAIL && id !== undefined) out._id = id
	}
	if (issues.length > 0) throw new KValidationError(issues)
	return out
}

function project(
	schema: KType,
	input: Value | undefined,
	path: KPath,
	issues: KIssue[],
): Value | undefined | typeof FAIL {
	let value = input
	// The last policy declared wins, as in parse; the walk runs from the outermost record inwards.
	let strip: boolean | undefined
	let current = schema
	while (current.prev !== null) {
		switch (current.op) {
			case 'optional':
				if (value === undefined && !defaultBelow(current.prev)) return undefined
				break
			case 'partial':
				if (value === undefined) return undefined
				break
			case 'nullable':
				if (value === null) return null
				break
			case 'default':
				if (value === undefined) {
					// SAFETY: a default is a Convex value of the field's type.
					value = current.arg as Value
				}
				break
			case 'strip':
				strip ??= true
				break
			case 'strict':
				strip ??= false
				break
			case 'transform':
			case 'pipe':
			case 'catch':
				throw new Error('Table projections cannot run a transform, pipe or catch')
			default:
				// Checks, normalisers and descriptions are not re-run on stored values.
				break
		}
		current = schemaOf(current.prev)
	}
	return projectRoot(current, value, path, issues, strip ?? false)
}

function projectRoot(
	root: KType,
	value: Value | undefined,
	path: KPath,
	issues: KIssue[],
	strip: boolean,
): Value | undefined | typeof FAIL {
	switch (root.op) {
		case 'object': {
			if (!isObjectValue(value)) return mismatch(issues, path, 'object')
			const fields = fieldsOf(root)
			const out: ProjectedRow = {}
			let failed = false
			for (const key of Object.keys(fields)) {
				const child = project(fields[key], value[key], [...path, key], issues)
				if (child === FAIL) failed = true
				else if (child !== undefined) setOwn(out, key, child)
			}
			for (const key of Object.keys(value)) {
				if (Object.hasOwn(fields, key) || strip) continue
				failed = true
				issues.push({
					path: [...path, key],
					code: 'unrecognized_key',
					message: `Unrecognized key: ${JSON.stringify(key)}`,
				})
			}
			return failed ? FAIL : out
		}
		case 'array': {
			if (!Array.isArray(value)) return mismatch(issues, path, 'array')
			const element = schemaOf(root.arg)
			const out: Value[] = []
			let failed = false
			for (let index = 0; index < value.length; index++) {
				const child = project(element, value[index], [...path, index], issues)
				if (child === FAIL || child === undefined) failed = true
				else out.push(child)
			}
			return failed ? FAIL : out
		}
		case 'record': {
			if (!isObjectValue(value)) return mismatch(issues, path, 'record')
			const [keySchema, valueSchema] = childrenOf(root)
			const out: ProjectedRow = {}
			let failed = false
			for (const key of Object.keys(value)) {
				const projectedKey = project(keySchema, key, [...path, key], issues)
				const child = project(valueSchema, value[key], [...path, key], issues)
				if (projectedKey === FAIL || child === FAIL || child === undefined) failed = true
				else setOwn(out, key, child)
			}
			return failed ? FAIL : out
		}
		case 'union':
		case 'discriminatedUnion': {
			for (const member of childrenOf(root)) {
				const attempt: KIssue[] = []
				const result = project(member, value, path, attempt)
				if (result !== FAIL && attempt.length === 0) return result
			}
			issues.push({
				path,
				code: 'invalid_union',
				message: 'Invalid input: no union member matched',
			})
			return FAIL
		}
		default:
			return leafMatches(root, value) ? value : mismatch(issues, path, root.op)
	}
}

/* oxlint-disable anti-slop/no-runtime-typeof -- A stored row reaches toPublicDto as Convex values; this is the structural re-check (R16) that decodes each one by representation. */
function leafMatches(root: KType, value: Value | undefined): boolean {
	switch (root.op) {
		case 'string':
		case 'id':
		case 'isoDate':
		case 'isoDateTime':
			return typeof value === 'string'
		case 'number':
		case 'int':
		case 'timestamp':
			return typeof value === 'number'
		case 'int64':
			return typeof value === 'bigint'
		case 'boolean':
			return typeof value === 'boolean'
		case 'null':
			return value === null
		case 'bytes':
			return value instanceof ArrayBuffer
		case 'any':
		case 'json':
			return value !== undefined
		case 'jsonObject':
			return isObjectValue(value)
		case 'literal':
			return value === root.arg
		case 'enum':
			// SAFETY: k.enum stores its value list as the root argument.
			return typeof value === 'string' && (root.arg as readonly string[]).includes(value)
		default:
			throw new Error(`cvx-kit/table: cannot project a '${root.op}' schema`)
	}
}

function isObjectValue(value: Value | undefined): value is StoredRow {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof ArrayBuffer)
	)
}

function isBigint(value: KType['arg']): boolean {
	return typeof value === 'bigint'
}

function isString(value: KType['arg']): value is string {
	return typeof value === 'string'
}
/* oxlint-enable anti-slop/no-runtime-typeof */

function mismatch(issues: KIssue[], path: KPath, expected: string): typeof FAIL {
	issues.push({ path, code: 'invalid_type', message: `Invalid input: expected ${expected}` })
	return FAIL
}

/** Whether a default sits below an optional record, so `undefined` still receives it. */
function defaultBelow(node: KType['prev']): boolean {
	for (let current = node; current !== null; current = current.prev) {
		if (current.op === 'default') return true
		if (current.op === 'transform' || current.op === 'pipe' || current.op === 'partial')
			return false
	}
	return false
}

function schemaOf(node: KType['prev'] | KType['arg']): KType {
	// SAFETY: every record and argument reached from a k root was created by a k factory.
	return node as KType
}

function fieldsOf(root: KType): KFields {
	// SAFETY: k.object stores its field map as the root argument.
	return root.arg as KFields
}

function discriminatedOf(root: KType): KDiscriminated {
	// SAFETY: k.discriminatedUnion stores its key and options as the root argument.
	return root.arg as KDiscriminated
}
