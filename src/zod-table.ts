import {
	convexToZod,
	zid,
	type ConvexValidatorFromZod,
	type Zid,
} from 'convex-helpers/server/zod4'
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

/** Preserves discriminated-union storage while retaining the same table owner. */
export function zodVariantTable<Table extends string, Schema extends z.ZodType>(
	tableName: Table,
	storage: Schema,
) {
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
 * This restriction applies only to new DTO extensions; storage/publicDto are unchanged.
 */
function assertDtoValidationSchema(
	schema: z.core.$ZodType,
	seen = new Set<z.core.$ZodType>(),
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
	const visit = (child: z.core.$ZodType) => assertDtoValidationSchema(child, seen)
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
): void {
	for (const key of [...server, ...command, ...publicKeys]) {
		if (!Object.hasOwn(fields, key)) throw new Error(`Unknown table field "${key}"`)
	}
	const managed = new Set<string>([...TIMESTAMP_FIELDS, ...server])
	for (const key of command) {
		if (managed.has(key)) throw new Error(`Server-owned field "${key}" cannot be a command input`)
	}
}
