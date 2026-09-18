import {
	convexToZod,
	zid,
	zodToConvex,
	type ConvexValidatorFromZod,
} from 'convex-helpers/server/zod4'
import { defineTable, paginationOptsValidator, type TableDefinition } from 'convex/server'
import type { GenericId } from 'convex/values'
import { z } from 'zod'

// Use this entry point when deriving validators from kit-owned schemas so
// the producer and converter consult the same convex-helpers ID registry.
export { zid, zodToConvex, convexToZod } from 'convex-helpers/server/zod4'

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

export const TIMESTAMP_FIELDS = ['createdAt', 'updatedAt', 'archivedAt'] as const

export type TableBoundaryOptions<
	Fields extends FieldSchemas,
	ServerFields extends readonly FieldKey<Fields>[],
	CommandFields extends readonly FieldKey<Fields>[],
	PublicFields extends readonly FieldKey<Fields & TimestampFields>[],
> = {
	serverFields?: ServerFields
	commandFields?: CommandFields
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

/** Named schema relationships keep generated declarations bounded and consumers fully typed. */
export type TableBoundary<
	Table extends string,
	Fields extends FieldSchemas,
	ServerFields extends readonly FieldKey<Fields>[],
	CommandFields extends readonly FieldKey<Fields>[],
	PublicFields extends readonly FieldKey<Fields & TimestampFields>[],
> = {
	tableName: Table
	storage: StrictObject<Fields & TimestampFields>
	schema: ReturnType<typeof documentSchema<Fields & TimestampFields, Table>>
	insertSchema: StrictObject<WriteFields<Fields, ServerFields>>
	updateSchema: StrictObject<PartialFields<WriteFields<Fields, ServerFields>>>
	commandInput: StrictObject<Pick<Fields & TimestampFields, CommandFields[number]>>
	publicDto: StrictObject<Pick<Fields & TimestampFields, PublicFields[number]>>
	toPublicDto: (
		row: z.input<StrictObject<Fields & TimestampFields>>,
	) => z.output<StrictObject<Pick<Fields & TimestampFields, PublicFields[number]>>>
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
	fields: (id: typeof zid) => Fields,
	options: TableBoundaryOptions<Fields, ServerFields, CommandFields, PublicFields> = {},
): TableBoundary<Table, Fields, ServerFields, CommandFields, PublicFields> {
	const columns: Fields & TimestampFields = { ...fields(zid), ...timestampFields }
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
	const toPublicDto = (row: z.input<typeof storage>) =>
		publicDto.parse(
			Object.fromEntries(
				Object.keys(publicDto.shape).map((key) => {
					// SAFETY: publicDto contains only keys selected from the storage fields.
					return [key, row[key as keyof typeof row]]
				}),
			),
		)

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

	const table: TableDefinition<ConvexValidatorFromZod<typeof storage, 'required'>> = defineTable(
		zodToConvex(storage),
	)
	return {
		tableName,
		schema,
		storage,
		insertSchema,
		updateSchema,
		commandInput,
		publicDto,
		toPublicDto,
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
	fields: (id: typeof zid) => Fields,
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
	>(tableName, (id) => ({ ...fields(id), ...tenantFields }), {
		...options,
		serverFields: [...(options.serverFields ?? []), 'tenant'],
	})
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
