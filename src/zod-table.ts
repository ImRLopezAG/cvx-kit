import { convexToZod, zid, type ConvexValidatorFromZod, type Zid } from 'convex-helpers/server/zod4'
import { defineTable, paginationOptsValidator, type TableDefinition } from 'convex/server'
import type { GenericId } from 'convex/values'
import { z } from 'zod'

import { zodToConvex } from './zod-convex'

import {
	scalarPaginationSchema,
	type ScalarPaginationSchema,
	type ScalarSelection,
	type ExactScalarSelection,
} from './querying/filters'

// Use this entry point when deriving validators from kit-owned schemas so
// the producer and converter consult the same convex-helpers ID registry.
export { zid, convexToZod } from 'convex-helpers/server/zod4'
export { zodToConvex } from './zod-convex'

type FieldSchemas = Record<string, z.ZodType>
type FieldKey<Fields extends FieldSchemas> = Extract<keyof Fields, string>

/**
 * Opinionated lifecycle timestamps — every table has them, server-owned,
 * always excluded from insert/command boundaries. Maintained by the
 * `timestamps` trigger helper (see cvx-kit/triggers).
 */
const timestampFields = {
	createdAt: z.number().optional(),
	updatedAt: z.number().optional(),
	archivedAt: z.number().optional(),
} satisfies FieldSchemas

type TimestampFields = typeof timestampFields
type ReservedStorageField = '_id' | '_creationTime' | keyof TimestampFields
type OwnedFields<Fields> = {
	[Key in keyof Fields]: Key extends ReservedStorageField ? never : Fields[Key]
}
type SystemFields<Table extends string> = { _id: Zid<Table>; _creationTime: z.ZodNumber }

export const TIMESTAMP_FIELDS = ['createdAt', 'updatedAt', 'archivedAt'] as const

export type TableBoundaryOptions<
	Fields extends FieldSchemas,
	ServerFields extends readonly FieldKey<Fields>[],
	CommandFields extends readonly FieldKey<Fields>[],
	PublicFields extends readonly FieldKey<Fields & TimestampFields>[],
> = {
	serverFields?: ServerFields
	commandFields?: CommandFields &
		readonly Exclude<FieldKey<Fields>, ServerFields[number] | keyof TimestampFields>[]
	publicFields?: PublicFields
}

type StrictObject<Fields extends FieldSchemas> = z.ZodObject<Fields, z.core.$strict>
type WriteFields<
	Fields extends FieldSchemas,
	ServerFields extends readonly FieldKey<Fields>[],
> = Omit<Fields & TimestampFields, ServerFields[number] | (typeof TIMESTAMP_FIELDS)[number]>
type PartialFields<Fields extends FieldSchemas> = {
	[Key in keyof Fields]: z.ZodOptional<Fields[Key]>
}

/** Options shared by the DTO return schema and row projector.
 * Promised contributions must be present, including in reusable options.
 * New extension schemas support validation only: no transforms, pipes,
 * coercion, preprocess, defaults, catches, or overwrites, even when nested.
 * Refinements must validate without mutating their input.
 */
export type DtoOptions<IncludeId extends boolean = false, Extension extends FieldSchemas = {}> = ([
	IncludeId,
] extends [true]
	? { _id: IncludeId }
	: { _id?: IncludeId }) &
	(keyof Extension extends never ? { extend?: Extension } : { extend: Extension })

type DtoProjectionOptions<IncludeId extends boolean> = DtoOptions<IncludeId> & {
	extend?: Record<string, never>
	values?: never
}

type ReservedDtoField =
	| '_id'
	| '_creationTime'
	| 'tenant'
	| '__proto__'
	| (typeof TIMESTAMP_FIELDS)[number]
type DtoExtension<Public extends FieldSchemas, Extension extends FieldSchemas> = {
	[Key in keyof Extension]: Key extends keyof Public | ReservedDtoField
		? never
		: Extension[Key] extends z.ZodPipe | z.ZodTransform
			? never
			: unknown
}
// Broad dictionaries cannot promise any particular extension field.
type KnownExtension<Extension> = string extends keyof Extension ? {} : Extension

type DtoSchema<
	Table extends string,
	Public extends FieldSchemas,
	IncludeId extends boolean,
	Extension extends FieldSchemas = {},
> = IncludeId extends true
	? StrictObject<Public & { _id: Zid<Table> } & KnownExtension<Extension>>
	: StrictObject<Public & KnownExtension<Extension>>
type DtoRow<Row, IncludeId extends boolean> = Row & (true extends IncludeId ? { _id: string } : {})
type DtoValues<Extension extends FieldSchemas> = keyof Extension extends never
	? { values?: never }
	: { values: z.input<StrictObject<NoInfer<Extension>>> }

type DtoBoundary<Table extends string, Fields extends FieldSchemas, Public extends FieldSchemas> = {
	dto(): StrictObject<Public>
	dto<const IncludeId extends boolean>(includeId: IncludeId): DtoSchema<Table, Public, IncludeId>
	dto<const IncludeId extends boolean = false>(
		options: DtoProjectionOptions<IncludeId>,
	): DtoSchema<Table, Public, IncludeId>
	dto<const IncludeId extends boolean = false, const Extension extends FieldSchemas = {}>(
		options: DtoOptions<IncludeId, Extension> & { extend?: DtoExtension<Public, Extension> },
	): DtoSchema<Table, Public, IncludeId, Extension>
	toPublicDto(row: z.input<StrictObject<Fields>>): z.output<StrictObject<Public>>
	toPublicDto<const IncludeId extends boolean>(
		row: DtoRow<z.input<StrictObject<Fields>>, IncludeId>,
		includeId: IncludeId,
	): z.output<DtoSchema<Table, Public, IncludeId>>
	toPublicDto<const IncludeId extends boolean = false>(
		row: DtoRow<z.input<StrictObject<Fields>>, IncludeId>,
		options: DtoProjectionOptions<IncludeId>,
	): z.output<DtoSchema<Table, Public, IncludeId>>
	toPublicDto<const IncludeId extends boolean = false, const Extension extends FieldSchemas = {}>(
		row: DtoRow<z.input<StrictObject<Fields>>, IncludeId>,
		options: DtoOptions<IncludeId, Extension> & {
			extend?: DtoExtension<Public, Extension>
		} & DtoValues<Extension>,
	): z.output<DtoSchema<Table, Public, IncludeId, Extension>>
}

/** Named schema relationships keep generated declarations bounded and consumers fully typed. */
export type TableBoundary<
	Table extends string,
	Fields extends FieldSchemas,
	ServerFields extends readonly FieldKey<Fields>[],
	CommandFields extends readonly FieldKey<Fields>[],
	PublicFields extends readonly FieldKey<Fields & TimestampFields>[],
> = DtoBoundary<
	Table,
	Fields & TimestampFields,
	Pick<Fields & TimestampFields, PublicFields[number]>
> & {
	paginationOpts<
		const Selection extends ScalarSelection<Fields & TimestampFields & SystemFields<Table>>,
	>(
		selection: ExactScalarSelection<Fields & TimestampFields & SystemFields<Table>, Selection>,
	): ScalarPaginationSchema<Fields & TimestampFields & SystemFields<Table>, Selection>
	tableName: Table
	storage: StrictObject<Fields & TimestampFields>
	schema: ReturnType<typeof documentSchema<Fields & TimestampFields, Table>>
	insertSchema: StrictObject<WriteFields<Fields, ServerFields>>
	updateSchema: StrictObject<PartialFields<WriteFields<Fields, ServerFields>>>
	commandInput: StrictObject<Pick<Fields & TimestampFields, CommandFields[number]>>
	publicDto: StrictObject<Pick<Fields & TimestampFields, PublicFields[number]>>
	table: TableDefinition<ConvexValidatorFromZod<StrictObject<Fields & TimestampFields>, 'required'>>
	insert(): StrictObject<WriteFields<Fields, ServerFields>>
	insert<Mask extends z.util.Mask<keyof WriteFields<Fields, ServerFields>>>(
		omit: Mask,
	): ZodObjectOmit<StrictObject<WriteFields<Fields, ServerFields>>, Mask>
	update(): StrictObject<PartialFields<WriteFields<Fields, ServerFields>>>
	update<Mask extends z.util.Mask<keyof WriteFields<Fields, ServerFields>>>(
		omit: Mask,
	): ZodObjectOmit<StrictObject<PartialFields<WriteFields<Fields, ServerFields>>>, Mask>
	tools: {
		insert: StrictObject<Pick<Fields & TimestampFields, CommandFields[number]>>
		update: StrictObject<{
			data: StrictObject<PartialFields<Pick<Fields & TimestampFields, CommandFields[number]>>>
			id: z.ZodType<GenericId<Table>, string>
		}>
		id: StrictObject<{ id: z.ZodType<GenericId<Table>, string> }>
	}
}

/** Defines one table and derives its storage, document, write, and DTO boundaries. */
export function zodTable<
	Table extends string,
	Fields extends FieldSchemas,
	const ServerFields extends readonly FieldKey<Fields>[] = readonly [],
	const CommandFields extends readonly FieldKey<Fields>[] = readonly [],
	const PublicFields extends readonly FieldKey<Fields & TimestampFields>[] = readonly [],
>(
	tableName: Table,
	fields: (id: typeof zid) => Fields & OwnedFields<Fields>,
	options: TableBoundaryOptions<Fields, ServerFields, CommandFields, PublicFields> = {},
): TableBoundary<Table, Fields, ServerFields, CommandFields, PublicFields> {
	const declared = fields(zid)
	assertOwnedFields(declared, ['_id', '_creationTime', ...TIMESTAMP_FIELDS])
	const columns: Fields & TimestampFields = { ...declared, ...timestampFields }
	assertFieldLists(
		columns,
		options.serverFields ?? [],
		options.commandFields ?? [],
		options.publicFields ?? [],
	)
	const storage: z.ZodObject<Fields & TimestampFields, z.core.$strict> = z.object(columns).strict()
	const schema = documentSchema(storage, tableName)
	const omittedKeys: readonly (ServerFields[number] | (typeof TIMESTAMP_FIELDS)[number])[] = [
		...TIMESTAMP_FIELDS,
		...(options.serverFields ?? []),
	]
	const commandKeys: readonly CommandFields[number][] = options.commandFields ?? []
	const publicKeys: readonly PublicFields[number][] = options.publicFields ?? []
	const insertSchema: z.ZodObject<WriteFields<Fields, ServerFields>, z.core.$strict> = z
		.object(omitFields(columns, omittedKeys))
		.strict()
	const updateSchema = insertSchema.partial()
	const commandInput: z.ZodObject<
		Pick<Fields & TimestampFields, CommandFields[number]>,
		z.core.$strict
	> = z.object(pickFields(columns, commandKeys)).strict()
	const publicDto: z.ZodObject<
		Pick<Fields & TimestampFields, PublicFields[number]>,
		z.core.$strict
	> = z.object(pickFields(columns, publicKeys)).strict()
	type Public = Pick<Fields & TimestampFields, PublicFields[number]>
	type Row = z.input<typeof storage>
	type RuntimeDtoFields = Public & FieldSchemas
	type RuntimeDto = z.output<StrictObject<RuntimeDtoFields>> & { _id?: GenericId<Table> }
	type RuntimeOptions = { _id?: boolean; extend?: FieldSchemas; values?: unknown }
	const reservedDtoFields = new Set<string>([
		'_id',
		'_creationTime',
		'tenant',
		'__proto__',
		...TIMESTAMP_FIELDS,
	])

	function dto(): typeof publicDto
	function dto<const IncludeId extends boolean>(
		includeId: IncludeId,
	): DtoSchema<Table, Public, IncludeId>
	function dto<const IncludeId extends boolean = false>(
		options: DtoProjectionOptions<IncludeId>,
	): DtoSchema<Table, Public, IncludeId>
	function dto<const IncludeId extends boolean = false, const Extension extends FieldSchemas = {}>(
		options: DtoOptions<IncludeId, Extension> & { extend?: DtoExtension<Public, Extension> },
	): DtoSchema<Table, Public, IncludeId, Extension>
	function dto(options?: boolean | RuntimeOptions) {
		return deriveDto(options)
	}

	function deriveDto(options?: boolean | RuntimeOptions) {
		const normalized = options === true || options === false ? { _id: options } : options
		const extension = normalized?.extend ?? {}
		for (const key of Object.keys(extension)) {
			if (reservedDtoFields.has(key) || Object.hasOwn(publicDto.shape, key)) {
				throw new Error(`DTO extension collision for field "${key}" on table "${tableName}"`)
			}
			assertDtoValidationSchema(extension[key])
		}
		if (!normalized?._id && Object.keys(extension).length === 0) return publicDto
		const resultSchema = z.object({ ...publicDto.shape, ...extension }).strict()
		return normalized?._id ? resultSchema.extend({ _id: schema.shape._id }) : resultSchema
	}

	function toPublicDto(row: Row): z.output<typeof publicDto>
	function toPublicDto<const IncludeId extends boolean>(
		row: DtoRow<Row, IncludeId>,
		includeId: IncludeId,
	): z.output<DtoSchema<Table, Public, IncludeId>>
	function toPublicDto<const IncludeId extends boolean = false>(
		row: DtoRow<Row, IncludeId>,
		options: DtoProjectionOptions<IncludeId>,
	): z.output<DtoSchema<Table, Public, IncludeId>>
	function toPublicDto<
		const IncludeId extends boolean = false,
		const Extension extends FieldSchemas = {},
	>(
		row: DtoRow<Row, IncludeId>,
		options: DtoOptions<IncludeId, Extension> & {
			extend?: DtoExtension<Public, Extension>
		} & DtoValues<Extension>,
	): z.output<DtoSchema<Table, Public, IncludeId, Extension>>
	function toPublicDto(row: Row, options?: boolean | RuntimeOptions): RuntimeDto {
		const normalized = options === true || options === false ? { _id: options } : options
		// Enforce extension collisions and validation-only schemas before parsing values.
		deriveDto(options)
		const projected = publicDto.parse(
			Object.fromEntries(
				Object.keys(publicDto.shape).map((key) => {
					// SAFETY: publicDto contains only keys selected from the storage fields.
					return [key, row[key as keyof typeof row]]
				}),
			),
		)
		const extension = z
			.object(normalized?.extend ?? {})
			.strict()
			.parse(normalized?.values ?? {})
		const result: RuntimeDto = { ...projected, ...extension }
		if (normalized?._id) {
			result._id = schema.shape._id.parse('_id' in row ? row._id : undefined)
		}
		return result
	}

	type InsertSchema = typeof insertSchema
	type UpdateSchema = typeof updateSchema
	type InsertMask = z.util.Mask<keyof InsertSchema['shape']>
	type UpdateMask = z.util.Mask<keyof UpdateSchema['shape']>

	function insert(): InsertSchema
	function insert<OmitMask extends InsertMask>(
		omit: OmitMask,
	): ZodObjectOmit<InsertSchema, OmitMask>
	function insert(omit?: InsertMask) {
		// SAFETY: InsertMask contains only insertSchema keys; the overload retains Zod's exact mask relationship.
		return omit ? insertSchema.omit(omit as never) : insertSchema
	}

	function update(): UpdateSchema
	function update<OmitMask extends UpdateMask>(
		omit: OmitMask,
	): ZodObjectOmit<UpdateSchema, OmitMask>
	function update(omit?: UpdateMask) {
		// SAFETY: UpdateMask contains only updateSchema keys; the overload retains Zod's exact mask relationship.
		return omit ? updateSchema.omit(omit as never) : updateSchema
	}

	const nativeStorage = zodToConvex(storage)
	const table: TableDefinition<ConvexValidatorFromZod<typeof storage, 'required'>> =
		defineTable(nativeStorage)
	type EntityFields = Fields & TimestampFields & SystemFields<Table>
	function paginationOpts<const Selection extends ScalarSelection<EntityFields>>(
		selection: ExactScalarSelection<EntityFields, Selection>,
	): ScalarPaginationSchema<EntityFields, Selection> {
		return scalarPaginationSchema<EntityFields, Selection>(zodToConvex(schema).fields, selection)
	}
	return {
		tableName,
		schema,
		storage,
		insertSchema,
		updateSchema,
		commandInput,
		publicDto,
		dto,
		toPublicDto,
		paginationOpts,
		table,
		insert,
		update,
		tools: {
			// jsonSafeZid (not zid): tool masks feed generated JSON schemas, so
			// ids must present as plain strings while keeping the Id<...> type.
			insert: commandInput,
			update: z.object({ data: commandInput.partial(), id: jsonSafeZid(tableName) }).strict(),
			id: z.object({ id: jsonSafeZid(tableName) }).strict(),
		},
	}
}

/** Reuses ordinary fields while deriving every boundary through zodTable. */
export function createTable<Shared extends FieldSchemas>(shared: Shared & OwnedFields<Shared>) {
	assertOwnedFields(shared, ['_id', '_creationTime', ...TIMESTAMP_FIELDS])
	return function customTable<
		Table extends string,
		Fields extends FieldSchemas,
		const ServerFields extends readonly FieldKey<Shared & Fields>[] = readonly [],
		const CommandFields extends readonly FieldKey<Shared & Fields>[] = readonly [],
		const PublicFields extends readonly FieldKey<Shared & Fields & TimestampFields>[] = readonly [],
	>(
		tableName: Table,
		fields: (id: typeof zid) => Fields &
			OwnedFields<Fields> & {
				[Key in keyof Fields]: Key extends (string extends keyof Shared ? never : keyof Shared)
					? never
					: Fields[Key]
			},
		options: TableBoundaryOptions<Shared & Fields, ServerFields, CommandFields, PublicFields> = {},
	): TableBoundary<Table, Shared & Fields, ServerFields, CommandFields, PublicFields> {
		return zodTable<Table, Shared & Fields, ServerFields, CommandFields, PublicFields>(
			tableName,
			(id) => {
				const declared = fields(id)
				for (const key of Object.keys(declared)) {
					if (Object.hasOwn(shared, key))
						throw new Error(`Duplicate shared table field "${key}" on table "${tableName}"`)
				}
				assertOwnedFields(declared, ['_id', '_creationTime', ...TIMESTAMP_FIELDS])
				const combined: Shared & Fields = { ...shared, ...declared }
				// SAFETY: duplicates and reserved keys are rejected before merging; like
				// tenantTable, this wrapper forwards the unchanged validators to zodTable.
				return combined as Shared & Fields & OwnedFields<Shared & Fields>
			},
			options,
		)
	}
}

const tenantFields = {
	tenant: z.string().min(1),
} satisfies FieldSchemas

type TenantFields = typeof tenantFields

/**
 * A zodTable whose rows are tenant-owned: injects the server-owned `tenant`
 * field (the tenancy boundary — see cvx-kit/tenancy). Like timestamps, it is
 * excluded from insert/update/command boundaries; handlers stamp it from
 * ctx.tenant, row-level security matches on it, and the tenantOwnership
 * trigger forbids reassigning it. Expose it via publicFields only when a DTO
 * genuinely needs it.
 */
export function tenantTable<
	Table extends string,
	Fields extends FieldSchemas,
	const ServerFields extends readonly FieldKey<Fields>[] = readonly [],
	const CommandFields extends readonly FieldKey<Fields>[] = readonly [],
	const PublicFields extends readonly FieldKey<Fields & TenantFields & TimestampFields>[] =
		readonly [],
>(
	tableName: Table,
	fields: (
		id: typeof zid,
	) => Fields &
		OwnedFields<Fields> & { [Key in keyof Fields]: Key extends 'tenant' ? never : Fields[Key] },
	options: TableBoundaryOptions<
		Fields & TenantFields,
		readonly (ServerFields[number] | 'tenant')[],
		CommandFields,
		PublicFields
	> = {},
) {
	return zodTable<
		Table,
		Fields & TenantFields,
		readonly (ServerFields[number] | 'tenant')[],
		CommandFields,
		PublicFields
	>(
		tableName,
		(id) => {
			const declared = fields(id)
			assertOwnedFields(declared, ['tenant', '_id', '_creationTime', ...TIMESTAMP_FIELDS])
			// SAFETY: reserved keys were rejected before injecting tenant; the generic
			// wrapper forwards the same checked fields to the ordinary table constructor.
			return { ...declared, ...tenantFields } as Fields &
				TenantFields &
				OwnedFields<Fields & TenantFields>
		},
		{
			...options,
			serverFields: [...(options.serverFields ?? []), 'tenant'],
		},
	)
}

/**
 * Merges per-module table maps into the application schema map, rejecting
 * duplicate table names across modules — the module-registry combinator for
 * domain/table.ts: `defineSchema(createModule(catalogTables, salesTables))`.
 */
export function createModule<const Maps extends readonly Record<string, TableDefinition<any>>[]>(
	...maps: Maps
): UnionToIntersection<Maps[number]> {
	const combined: Record<string, TableDefinition<any>> = {}
	for (const map of maps) {
		for (const [tableName, definition] of Object.entries(map)) {
			if (tableName in combined) {
				throw new Error(`Table "${tableName}" is declared by more than one module`)
			}
			combined[tableName] = definition
		}
	}
	// SAFETY: every input entry is copied, and duplicate keys are rejected above.
	return combined as UnionToIntersection<Maps[number]>
}

type UnionToIntersection<Union> = (
	Union extends unknown ? (member: Union) => void : never
) extends (member: infer Intersection) => void
	? Intersection
	: never

/**
 * Cursor-pagination boundary schemas bridged from Convex's own validators:
 * `args.paginationOpts` for function args, `result` for the page shape.
 * Pair with `include(...).paginate(opts)` (cvx-kit/auth). The result object
 * is deliberately non-strict — Convex may attach engine fields (splitCursor,
 * pageStatus); the page items themselves are validated against the dto.
 * Note: under row-level security, pages may be SHORTER than numItems when
 * rules reject rows mid-page; cursors remain correct.
 */
export function paginated<Dto extends z.ZodType>(dto: Dto) {
	return {
		args: { paginationOpts: convexToZod(paginationOptsValidator) },
		result: z.object({
			page: z.array(dto),
			isDone: z.boolean(),
			continueCursor: z.string(),
			splitCursor: z.string().nullable().optional(),
			pageStatus: z.enum(['SplitRecommended', 'SplitRequired']).nullable().optional(),
		}),
	}
}

type VariantSchema = z.ZodDiscriminatedUnion<readonly StrictObject<FieldSchemas>[], string>
type VariantDiscriminator<Schema extends VariantSchema> = Schema['_zod']['def']['discriminator']
type VariantTags<Schema extends VariantSchema> = Extract<
	z.output<Schema>[VariantDiscriminator<Schema>],
	string
>
type VariantBranch<Schema extends VariantSchema, Tag extends string> = Extract<
	Schema['options'][number],
	z.ZodObject<{ [Key in VariantDiscriminator<Schema>]: z.ZodLiteral<Tag> }, z.core.$strict>
>
type VariantKeys<Schema extends VariantSchema, Tag extends string> = FieldKey<
	VariantBranch<Schema, Tag>['shape']
>

/** Boundary mode supports strict object branches with one string literal tag each. */
export type VariantBoundaryOptions<Schema extends VariantSchema> = {
	discriminator: VariantDiscriminator<Schema>
	timestamps?: boolean
	variants: {
		[Tag in VariantTags<Schema>]: {
			serverFields?: readonly Exclude<VariantKeys<Schema, Tag>, VariantDiscriminator<Schema>>[]
			commandFields?: readonly Exclude<VariantKeys<Schema, Tag>, VariantDiscriminator<Schema>>[]
			publicFields?: readonly (
				| Exclude<VariantKeys<Schema, Tag>, VariantDiscriminator<Schema>>
				| keyof TimestampFields
			)[]
		}
	}
}
type VariantMaskKeys<Config, Mask extends string> = Config extends {
	[Key in Mask]?: readonly (infer Field)[]
}
	? Extract<Field, string>
	: never
type CheckedVariantOptions<
	Schema extends VariantSchema,
	Options extends VariantBoundaryOptions<Schema>,
> = {
	variants: {
		[Tag in keyof Options['variants']]: Tag extends VariantTags<Schema>
			? {
					commandFields?: readonly Exclude<
						VariantKeys<Schema, Tag>,
						VariantDiscriminator<Schema> | VariantMaskKeys<Options['variants'][Tag], 'serverFields'>
					>[]
					publicFields?: readonly (
						| Exclude<VariantKeys<Schema, Tag>, VariantDiscriminator<Schema>>
						| (Options extends { timestamps: true } ? keyof TimestampFields : never)
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
type VariantFields<
	Table extends string,
	Branch extends StrictObject<FieldSchemas>,
	Discriminator extends string,
	Config,
	Timestamps extends boolean,
	Mode extends VariantMode,
> = Mode extends 'storage'
	? Branch['shape'] & (true extends Timestamps ? TimestampFields : {})
	: Mode extends 'document'
		? VariantFields<Table, Branch, Discriminator, Config, Timestamps, 'storage'> &
				SystemFields<Table>
		: Mode extends 'public' | 'command'
			? Pick<
					VariantFields<Table, Branch, Discriminator, Config, Timestamps, 'storage'>,
					Extract<
						| Discriminator
						| VariantMaskKeys<Config, Mode extends 'public' ? 'publicFields' : 'commandFields'>,
						keyof VariantFields<Table, Branch, Discriminator, Config, Timestamps, 'storage'>
					>
				>
			: Mode extends 'insert'
				? Omit<Branch['shape'], VariantMaskKeys<Config, 'serverFields'>>
				: PartialFields<
						Omit<
							VariantFields<
								Table,
								Branch,
								Discriminator,
								Config,
								Timestamps,
								Mode extends 'update' ? 'insert' : 'command'
							>,
							Discriminator
						>
					> &
						Pick<Branch['shape'], Extract<Discriminator, keyof Branch['shape']>>
type DerivedVariantBranches<
	Table extends string,
	Schema extends VariantSchema,
	Options extends VariantBoundaryOptions<Schema>,
	Mode extends VariantMode,
	IncludeId extends boolean,
	Branches extends readonly StrictObject<FieldSchemas>[],
> = {
	[Index in keyof Branches]: Branches[Index] extends StrictObject<FieldSchemas>
		? StrictObject<
				VariantFields<
					Table,
					Branches[Index],
					VariantDiscriminator<Schema>,
					Options['variants'][Extract<
						z.output<Branches[Index]>[VariantDiscriminator<Schema>],
						keyof Options['variants']
					>],
					Options extends { timestamps: infer Enabled }
						? true extends Enabled
							? true
							: false
						: false,
					Mode
				> &
					(IncludeId extends true ? { _id: Zid<Table> } : {})
			>
		: never
}
type DerivedVariant<
	Table extends string,
	Schema extends VariantSchema,
	Options extends VariantBoundaryOptions<Schema>,
	Mode extends VariantMode,
	IncludeId extends boolean = false,
> = IncludeId extends true
	? z.ZodDiscriminatedUnion<
			DerivedVariantBranches<Table, Schema, Options, Mode, true, Schema['options']>,
			VariantDiscriminator<Schema>
		>
	: z.ZodDiscriminatedUnion<
			DerivedVariantBranches<Table, Schema, Options, Mode, false, Schema['options']>,
			VariantDiscriminator<Schema>
		>

export type VariantTableBoundary<
	Table extends string,
	Schema extends VariantSchema,
	Options extends VariantBoundaryOptions<Schema>,
> = {
	tableName: Table
	storage: DerivedVariant<Table, Schema, Options, 'storage'>
	schema: DerivedVariant<Table, Schema, Options, 'document'>
	insertSchema: DerivedVariant<Table, Schema, Options, 'insert'>
	updateSchema: DerivedVariant<Table, Schema, Options, 'update'>
	commandInput: DerivedVariant<Table, Schema, Options, 'command'>
	publicDto: DerivedVariant<Table, Schema, Options, 'public'>
	table: TableDefinition<
		ConvexValidatorFromZod<DerivedVariant<Table, Schema, Options, 'storage'>, 'required'>
	>
	dto(): DerivedVariant<Table, Schema, Options, 'public'>
	dto<const IncludeId extends boolean>(
		includeId: IncludeId,
	): DerivedVariant<Table, Schema, Options, 'public', IncludeId>
	toPublicDto(
		row: z.input<DerivedVariant<Table, Schema, Options, 'storage'>>,
	): z.output<DerivedVariant<Table, Schema, Options, 'public'>>
	toPublicDto<const IncludeId extends boolean>(
		row: DtoRow<z.input<DerivedVariant<Table, Schema, Options, 'storage'>>, IncludeId>,
		includeId: IncludeId,
	): z.output<DerivedVariant<Table, Schema, Options, 'public', IncludeId>>
	tools: {
		id: StrictObject<{ id: z.ZodType<GenericId<Table>, string> }>
		insert: z.ZodType<
			z.output<DerivedVariant<Table, Schema, Options, 'command'>>,
			z.input<DerivedVariant<Table, Schema, Options, 'command'>>
		>
		update: StrictObject<{
			id: z.ZodType<GenericId<Table>, string>
			data: z.ZodType<
				z.output<DerivedVariant<Table, Schema, Options, 'commandUpdate'>>,
				z.input<DerivedVariant<Table, Schema, Options, 'commandUpdate'>>
			>
		}>
	}
}

/** Legacy mode preserves arbitrary storage; the third argument opts into derived boundaries. */
export function zodVariantTable<Table extends string, Schema extends z.ZodType>(
	tableName: Table,
	storage: Schema,
): {
	tableName: Table
	storage: Schema
	insertSchema: Schema
	table: TableDefinition<ConvexValidatorFromZod<Schema, 'required'>>
}
export function zodVariantTable<
	Table extends string,
	Schema extends VariantSchema,
	const Options extends VariantBoundaryOptions<Schema>,
>(
	tableName: Table,
	storage: Schema,
	options: Options & CheckedVariantOptions<Schema, NoInfer<Options>>,
): VariantTableBoundary<Table, Schema, Options>
export function zodVariantTable(
	tableName: string,
	storage: z.ZodType,
	options?: {
		discriminator: string
		timestamps?: boolean
		variants: Record<
			string,
			{
				serverFields?: readonly string[]
				commandFields?: readonly string[]
				publicFields?: readonly string[]
			}
		>
	},
) {
	if (options) return deriveVariantTable(tableName, storage, options)
	return {
		tableName,
		storage,
		insertSchema: storage,
		table: defineTable(zodToConvex(storage)),
	}
}

/**
 * A zid that presents as a plain string in generated JSON schemas so
 * LLM-tool inputs stay primitive, while keeping the Id type at compile time.
 */
export function jsonSafeZid<Table extends string>(
	tableName: Table,
): z.ZodType<GenericId<Table>, string> {
	const id = zid(tableName)
	return z
		.string()
		.refine((value): value is GenericId<Table> => id.safeParse(value).success)
		.describe(`Convex document id for table "${tableName}"; validated against the table by Convex`)
}

function deriveVariantTable(
	tableName: string,
	declared: z.ZodType,
	options: {
		discriminator: string
		timestamps?: boolean
		variants: Record<
			string,
			{
				serverFields?: readonly string[]
				commandFields?: readonly string[]
				publicFields?: readonly string[]
			}
		>
	},
) {
	if (
		!(declared instanceof z.ZodDiscriminatedUnion) ||
		declared.def.discriminator !== options.discriminator
	)
		throw new Error(
			'Variant boundaries require a discriminated union with the configured discriminator',
		)
	if (declared.def.checks?.length)
		throw new Error('Variant boundaries do not support union-level refinements')
	const discriminator = options.discriminator
	if (['_id', '_creationTime', ...TIMESTAMP_FIELDS].includes(discriminator))
		throw new Error('Variant discriminator cannot be a reserved field')
	const branches = new Map<
		string,
		{
			storage: StrictObject<FieldSchemas>
			document: StrictObject<FieldSchemas>
			insert: StrictObject<FieldSchemas>
			update: StrictObject<FieldSchemas>
			command: StrictObject<FieldSchemas>
			commandUpdate: StrictObject<FieldSchemas>
			public: StrictObject<FieldSchemas>
		}
	>()
	for (const branch of declared.options) {
		if (!(branch instanceof z.ZodObject) || !(branch.def.catchall instanceof z.ZodNever))
			throw new Error('Variant boundaries require strict object branches')
		if (branch.def.checks?.length)
			throw new Error('Variant boundaries do not support object-level refinements')
		try {
			assertDtoValidationSchema(branch, new Set(), true)
		} catch (cause) {
			throw new Error(
				'Variant boundaries require supported value-preserving field validators without object catchalls',
				{ cause },
			)
		}
		const tagSchema = branch.shape[discriminator]
		if (!(tagSchema instanceof z.ZodLiteral) || tagSchema.values.size !== 1)
			throw new Error('Variant branches require one string literal discriminator')
		const tag = [...tagSchema.values][0]
		if (!z.string().safeParse(tag).success)
			throw new Error('Variant branches require a string discriminator')
		// SAFETY: a single literal value was checked as a string above.
		const tagValue = tag as string
		if (branches.has(tagValue)) throw new Error(`Duplicate variant discriminator "${tagValue}"`)
		if (!Object.hasOwn(options.variants, tagValue))
			throw new Error(`Missing variant configuration "${tagValue}"`)
		const config = options.variants[tagValue]
		assertOwnedFields(branch.shape, [
			'_id',
			'_creationTime',
			...(options.timestamps === false ? [] : TIMESTAMP_FIELDS),
		])
		const columns = { ...branch.shape } satisfies FieldSchemas
		if (options.timestamps) Object.assign(columns, timestampFields)
		assertFieldLists(
			columns,
			config.serverFields ?? [],
			config.commandFields ?? [],
			config.publicFields ?? [],
			options.timestamps !== false,
		)
		for (const mask of [config.serverFields, config.commandFields, config.publicFields]) {
			if (mask?.includes(discriminator))
				throw new Error(
					'The variant discriminator is retained automatically and cannot appear in masks',
				)
		}
		const stored = z.strictObject(columns)
		const insert = z.strictObject(
			omitFields(columns, [
				...(options.timestamps === false ? [] : TIMESTAMP_FIELDS),
				...(config.serverFields ?? []),
			]),
		)
		const command = z.strictObject(
			pickFields(columns, [discriminator, ...(config.commandFields ?? [])]),
		)
		const partial = (schema: StrictObject<FieldSchemas>) =>
			schema.partial().extend({ [discriminator]: tagSchema })
		branches.set(tagValue, {
			storage: stored,
			document: documentSchema(stored, tableName),
			insert,
			update: partial(insert),
			command,
			commandUpdate: partial(command),
			public: z.strictObject(pickFields(columns, [discriminator, ...(config.publicFields ?? [])])),
		})
	}
	for (const tag of Object.keys(options.variants)) {
		if (!branches.has(tag)) throw new Error(`Unknown variant configuration "${tag}"`)
	}
	function union(mode: VariantMode, includeId = false, tool = false) {
		const schemas = [...branches.values()].map((branch) => {
			const schema = branch[mode]
			if (tool)
				return z.strictObject(
					Object.fromEntries(
						Object.entries(schema.shape).map(([key, field]) => [key, variantToolField(field)]),
					),
				)
			return includeId ? schema.extend({ _id: zid(tableName) }) : schema
		})
		if (!schemas.length) throw new Error('Variant boundaries require at least one branch')
		// SAFETY: all entries are checked strict objects with a unique required literal tag; nonempty checked above.
		return z.discriminatedUnion(
			discriminator,
			schemas as [StrictObject<FieldSchemas>, ...StrictObject<FieldSchemas>[]],
		)
	}
	const storage = union('storage')
	const schema = union('document')
	const insertSchema = union('insert')
	const updateSchema = union('update')
	const commandInput = union('command')
	const publicDto = union('public')
	function dto(includeId = false) {
		return includeId ? union('public', true) : publicDto
	}
	function toPublicDto(row: z.input<StrictObject<FieldSchemas>>, includeId = false) {
		const tag = z.string().parse(row[discriminator])
		const branch = branches.get(tag)
		if (!branch) throw new Error(`Unknown variant discriminator "${tag}"`)
		const projection = includeId ? branch.public.extend({ _id: zid(tableName) }) : branch.public
		return projection.parse(
			Object.fromEntries(
				Object.keys(projection.shape)
					.filter((key) => Object.hasOwn(row, key))
					.map((key) => [key, row[key]]),
			),
		)
	}
	return {
		tableName,
		storage,
		schema,
		insertSchema,
		updateSchema,
		commandInput,
		publicDto,
		dto,
		toPublicDto,
		table: defineTable(zodToConvex(storage)),
		tools: {
			id: z.strictObject({ id: jsonSafeZid(tableName) }),
			insert: union('command', false, true),
			update: z.strictObject({
				id: jsonSafeZid(tableName),
				data: union('commandUpdate', false, true),
			}),
		},
	}
}

function variantToolField(schema: z.core.$ZodType): z.ZodType {
	if (!(schema instanceof z.ZodType))
		throw new Error('Variant tools require classic Zod field schemas')
	if (
		schema instanceof z.ZodBigInt ||
		(schema instanceof z.ZodLiteral &&
			[...schema.values].some((value) => z.bigint().safeParse(value).success))
	)
		throw new Error(
			'Variant tool command fields cannot contain bigint; JSON Schema cannot represent it',
		)
	const native = zodToConvex(schema)
	if (native.kind === 'id') {
		const id = jsonSafeZid(native.tableName)
		if (native.isOptional === 'optional')
			return id.optional().refine((value) => schema.safeParse(value).success)
		return id.refine((value) => schema.safeParse(value).success)
	}
	if (schema instanceof z.ZodOptional)
		return schema.clone({ ...schema.def, innerType: variantToolField(schema.unwrap()) })
	if (schema instanceof z.ZodNullable)
		return schema.clone({ ...schema.def, innerType: variantToolField(schema.unwrap()) })
	if (schema instanceof z.ZodNonOptional)
		return schema.clone({ ...schema.def, innerType: variantToolField(schema.unwrap()) })
	if (schema instanceof z.ZodArray)
		return schema.clone({ ...schema.def, element: variantToolField(schema.element) })
	if (schema instanceof z.ZodObject) {
		const fields = Object.fromEntries(
			Object.entries(schema.shape).map(([key, child]) => [key, variantToolField(child)]),
		)
		return schema.clone(Object.assign({}, schema.def, { ['shape']: fields }))
	}
	if (schema instanceof z.ZodUnion)
		return schema.clone({ ...schema.def, options: schema.options.map(variantToolField) })
	if (schema instanceof z.ZodRecord)
		return schema.clone({
			...schema.def,
			// SAFETY: conversion preserves the original record key output; IDs remain strings.
			keyType: variantToolField(schema.keyType) as z.core.$ZodRecordKey,
			valueType: variantToolField(schema.valueType),
		})
	if (schema instanceof z.ZodTuple)
		return schema.clone({
			...schema.def,
			items: schema.def.items.map(variantToolField),
			rest: schema.def.rest ? variantToolField(schema.def.rest) : null,
		})
	if (schema instanceof z.ZodIntersection)
		return schema.clone({
			...schema.def,
			left: variantToolField(schema.def.left),
			right: variantToolField(schema.def.right),
		})
	return schema
}

type ZodObjectOmit<
	Schema extends z.ZodObject<any, any>,
	OmitMask extends z.util.Mask<keyof Schema['shape']>,
> =
	Schema extends z.ZodObject<infer ObjectFields, infer Config>
		? z.ZodObject<
				z.util.Flatten<Omit<ObjectFields, Extract<keyof ObjectFields, keyof OmitMask>>>,
				Config
			>
		: never

function documentSchema<Fields extends FieldSchemas, Table extends string>(
	storage: StrictObject<Fields>,
	tableName: Table,
) {
	return storage.extend({ _id: zid(tableName), _creationTime: z.number() })
}

function pickFields<Fields extends FieldSchemas, const Keys extends readonly FieldKey<Fields>[]>(
	fields: Fields,
	keys: Keys,
) {
	// SAFETY: each entry uses a requested key and its original validator, preserving Pick.
	return Object.fromEntries(keys.map((key) => [key, fields[key]])) as Pick<Fields, Keys[number]>
}

function omitFields<Fields extends FieldSchemas, const Keys extends readonly FieldKey<Fields>[]>(
	fields: Fields,
	keys: Keys,
) {
	const omitted = new Set<string>(keys)
	// SAFETY: filtering removes exactly the supplied keys and keeps every remaining validator.
	return Object.fromEntries(Object.entries(fields).filter(([key]) => !omitted.has(key))) as Omit<
		Fields,
		Keys[number]
	>
}

type DtoPropertiesCheck = z.core.$ZodCheck & {
	readonly _zod: {
		readonly def: { readonly check: 'properties' } & Record<
			'shape',
			Record<string, z.core.$ZodType>
		>
	}
}

/** Inspect Zod 4's discriminated definitions, failing closed for unsupported nodes.
 * Used by DTO extensions and opt-in variant boundaries; legacy schemas are unchanged.
 */
function assertDtoValidationSchema(
	schema: z.core.$ZodType,
	seen = new Set<z.core.$ZodType>(),
	allowNativeIds = false,
): void {
	if (seen.has(schema)) return
	seen.add(schema)
	// SAFETY: Zod 4 exposes its built-in schema definitions as this discriminated union.
	const def = (schema as z.core.$ZodTypes)._zod.def
	const reject = () => {
		throw new Error('DTO extensions require supported value-preserving validation schemas')
	}
	if ('coerce' in def && def.coerce) reject()
	if ('normalize' in def && def.normalize) reject()
	const visit = (child: z.core.$ZodType) => assertDtoValidationSchema(child, seen, allowNativeIds)
	for (const check of def.checks ?? []) {
		if (check._zod.def.check === 'overwrite') reject()
		if ('normalize' in check._zod.def && check._zod.def.normalize) reject()
		if (check._zod.def.check === 'property') {
			// SAFETY: the property discriminator owns this embedded schema in Zod 4.
			visit((check as z.core.$ZodCheckProperty)._zod.def.schema)
		}
		if (check._zod.def.check === 'properties') {
			// SAFETY: the properties discriminator owns this schema shape in Zod 4.
			for (const child of Object.values((check as DtoPropertiesCheck)._zod.def.shape)) {
				visit(child)
			}
		}
	}
	switch (def.type) {
		case 'custom':
			if (allowNativeIds && zodToConvex(schema).kind === 'id') return
			reject()
			return
		case 'string':
		case 'number':
		case 'boolean':
		case 'bigint':
		case 'date':
		case 'symbol':
		case 'null':
		case 'undefined':
		case 'void':
		case 'never':
		case 'literal':
		case 'enum':
			return
		case 'object':
			if (allowNativeIds && def.catchall && def.catchall._zod.def.type !== 'never')
				throw new Error('Variant fields cannot use object catchalls; use a record field instead')
			for (const child of Object.values(def.shape)) visit(child)
			if (def.catchall) visit(def.catchall)
			return
		case 'array':
			visit(def.element)
			return
		case 'optional':
		case 'nullable':
		case 'nonoptional':
			visit(def.innerType)
			return
		case 'union':
			for (const child of def.options) visit(child)
			return
		case 'intersection':
			visit(def.left)
			visit(def.right)
			return
		case 'tuple':
			for (const child of def.items) visit(child)
			if (def.rest) visit(def.rest)
			return
		case 'record':
			visit(def.keyType)
			visit(def.valueType)
			return
		default:
			reject()
	}
}

function assertOwnedFields(fields: FieldSchemas, reserved: readonly string[]): void {
	for (const key of reserved) {
		if (Object.hasOwn(fields, key))
			throw new Error(`Reserved table field "${key}" cannot be declared`)
	}
}

function assertFieldLists(
	fields: FieldSchemas,
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
