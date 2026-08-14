import {
	type ConvexValidatorFromZod,
	zid,
	zodToConvex,
} from 'convex-helpers/server/zod4'
import { defineTable, type TableDefinition } from 'convex/server'
import type { GenericId } from 'convex/values'
import { z } from 'zod'

type Shape = Record<string, z.ZodType>
type ShapeKey<Fields extends Shape> = Extract<keyof Fields, string>

/**
 * Opinionated lifecycle timestamps — every table has them, server-owned,
 * always excluded from insert/command boundaries. Maintained by the
 * `timestamps` trigger helper (see cvx-kit/triggers).
 */
const timestampShape = {
	createdAt: z.number().optional(),
	updatedAt: z.number().optional(),
	archivedAt: z.number().optional(),
} satisfies Shape

type TimestampShape = typeof timestampShape

export const TIMESTAMP_FIELDS = [
	'createdAt',
	'updatedAt',
	'archivedAt',
] as const

export type TableBoundaryOptions<
	Fields extends Shape,
	ServerFields extends readonly ShapeKey<Fields>[],
	CommandFields extends readonly ShapeKey<Fields>[],
	PublicFields extends readonly ShapeKey<Fields & TimestampShape>[],
> = {
	serverFields?: ServerFields
	commandFields?: CommandFields
	publicFields?: PublicFields
}

/** Defines one table and derives its storage, document, write, and DTO boundaries. */
export function zodTable<
	Table extends string,
	Fields extends Shape,
	const ServerFields extends readonly ShapeKey<Fields>[] = readonly [],
	const CommandFields extends readonly ShapeKey<Fields>[] = readonly [],
	const PublicFields extends readonly ShapeKey<
		Fields & TimestampShape
	>[] = readonly [],
>(
	tableName: Table,
	fields: (id: typeof zid) => Fields,
	options: TableBoundaryOptions<
		Fields,
		ServerFields,
		CommandFields,
		PublicFields
	> = {},
) {
	const shape = { ...fields(zid), ...timestampShape } as Fields &
		TimestampShape
	const storage = z.object(shape).strict()
	const schema = storage.extend({
		_id: zid(tableName),
		_creationTime: z.number(),
	})
	const insertSchema = z
		.object(
			omitShape(shape, [
				...TIMESTAMP_FIELDS,
				...(options.serverFields ?? ([] as never)),
			] as never),
		)
		.strict() as z.ZodObject<
		Omit<Fields, ServerFields[number] | (typeof TIMESTAMP_FIELDS)[number]>
	>
	const updateSchema = insertSchema.partial()
	const commandInput = z
		.object(pickShape(shape, options.commandFields ?? ([] as never)))
		.strict()
	const publicDto = z
		.object(pickShape(shape, options.publicFields ?? ([] as never)))
		.strict()
	const toPublicDto = (row: z.input<typeof storage>) =>
		publicDto.parse(
			Object.fromEntries(
				Object.keys(publicDto.shape).map((key) => [
					key,
					(row as Record<string, unknown>)[key],
				]),
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
		return omit ? insertSchema.omit(omit as never) : insertSchema
	}

	function update(): UpdateSchema
	function update<OmitMask extends UpdateMask>(
		omit: OmitMask,
	): ZodObjectOmit<UpdateSchema, OmitMask>
	function update(omit?: UpdateMask) {
		return omit ? updateSchema.omit(omit as never) : updateSchema
	}

	return {
		tableName,
		schema,
		storage,
		insertSchema,
		updateSchema,
		commandInput,
		publicDto,
		toPublicDto,
		table: defineTable(zodToConvex(storage)) as TableDefinition<
			ConvexValidatorFromZod<typeof storage, 'required'>
		>,
		insert,
		update,
		tools: {
			insert: commandInput,
			update: z
				.object({ data: commandInput.partial(), id: zid(tableName) })
				.strict(),
			id: z.object({ id: zid(tableName) }).strict(),
		},
	}
}

const tenantShape = {
	tenant: z.string().min(1),
} satisfies Shape

type TenantShape = typeof tenantShape

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
	Fields extends Shape,
	const ServerFields extends readonly ShapeKey<Fields>[] = readonly [],
	const CommandFields extends readonly ShapeKey<Fields>[] = readonly [],
	const PublicFields extends readonly ShapeKey<
		Fields & TenantShape & TimestampShape
	>[] = readonly [],
>(
	tableName: Table,
	fields: (id: typeof zid) => Fields,
	options: TableBoundaryOptions<
		Fields & TenantShape,
		readonly (ServerFields[number] | 'tenant')[],
		CommandFields,
		PublicFields
	> = {},
) {
	return zodTable(
		tableName,
		(id) => ({ ...fields(id), ...tenantShape }),
		{
			...options,
			serverFields: [
				...((options.serverFields ?? []) as readonly (
					| ServerFields[number]
					| 'tenant'
				)[]),
				'tenant',
			] as never,
		} as never,
	) as ReturnType<
		typeof zodTable<
			Table,
			Fields & TenantShape,
			readonly (ServerFields[number] | 'tenant')[],
			CommandFields,
			PublicFields
		>
	>
}

/**
 * Merges per-module table maps into the application schema map, rejecting
 * duplicate table names across modules — the module-registry combinator for
 * domain/table.ts: `defineSchema(createModule(catalogTables, salesTables))`.
 */
export function createModule<
	const Maps extends readonly Record<string, TableDefinition<any>>[],
>(...maps: Maps): UnionToIntersection<Maps[number]> {
	const combined: Record<string, TableDefinition<any>> = {}
	for (const map of maps) {
		for (const [tableName, definition] of Object.entries(map)) {
			if (tableName in combined) {
				throw new Error(
					`Table "${tableName}" is declared by more than one module`,
				)
			}
			combined[tableName] = definition
		}
	}
	return combined as UnionToIntersection<Maps[number]>
}

type UnionToIntersection<Union> = (
	Union extends unknown
		? (member: Union) => void
		: never
) extends (member: infer Intersection) => void
	? Intersection
	: never

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
export function jsonSafeZid<Table extends string>(tableName: Table) {
	return z
		.string()
		.describe(
			`Convex document id for table "${tableName}"`,
		) as unknown as z.ZodType<GenericId<Table>, string>
}

type ZodObjectOmit<
	Schema extends z.ZodObject<any, any>,
	OmitMask extends z.util.Mask<keyof Schema['shape']>,
> =
	Schema extends z.ZodObject<infer ObjectShape, infer Config>
		? z.ZodObject<
				z.util.Flatten<
					Omit<ObjectShape, Extract<keyof ObjectShape, keyof OmitMask>>
				>,
				Config
			>
		: never

function pickShape<
	Fields extends Shape,
	const Keys extends readonly ShapeKey<Fields>[],
>(fields: Fields, keys: Keys) {
	return Object.fromEntries(keys.map((key) => [key, fields[key]])) as Pick<
		Fields,
		Keys[number]
	>
}

function omitShape<
	Fields extends Shape,
	const Keys extends readonly ShapeKey<Fields>[],
>(fields: Fields, keys: Keys) {
	const omitted = new Set<string>(keys)
	return Object.fromEntries(
		Object.entries(fields).filter(([key]) => !omitted.has(key)),
	) as Omit<Fields, Keys[number]>
}
