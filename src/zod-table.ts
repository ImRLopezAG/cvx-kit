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

export type TableBoundaryOptions<
	Fields extends Shape,
	ServerFields extends readonly ShapeKey<Fields>[],
	CommandFields extends readonly ShapeKey<Fields>[],
	PublicFields extends readonly ShapeKey<Fields>[],
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
	const PublicFields extends readonly ShapeKey<Fields>[] = readonly [],
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
	const shape = fields(zid)
	const storage = z.object(shape).strict()
	const schema = storage.extend({
		_id: zid(tableName),
		_creationTime: z.number(),
	})
	const insertSchema = z
		.object(omitShape(shape, options.serverFields ?? ([] as never)))
		.strict()
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

/** Server-owned audit timestamps; spread into a shape and list in serverFields. */
export const timestampFields = {
	createdAt: z.number(),
	updatedAt: z.number(),
} satisfies Shape

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
