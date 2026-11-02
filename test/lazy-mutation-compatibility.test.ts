// @vitest-environment node
import { expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { zodTable, zodVariantTable } from '../src/zod-table'

it.each(['ordinary', 'variant'] as const)(
	'%s lazy siblings preserve declaration-time field maps',
	(kind) => {
		const field: z.ZodType = z.string()
		// oxlint-disable-next-line anti-slop/no-known-value-widening -- This runtime mutation proof shares one concrete schema-only test boundary across ordinary and variant tables.
		const boundary: {
			storage: z.ZodType
			insertSchema: z.ZodType
			commandInput: z.ZodType
			updateSchema: z.ZodType
			schema: z.ZodType
			tools: { update: z.ZodType }
		} =
			kind === 'ordinary'
				? zodTable('items', () => ({ name: field }), { commandFields: ['name'] })
				: zodVariantTable(
						'items',
						z.discriminatedUnion('type', [
							z.strictObject({ type: z.literal('item'), name: field }),
						]),
						{ discriminator: 'type', variants: { item: { commandFields: ['name'] } } },
					)
		const insert = boundary.insertSchema
		const storage = boundary.storage
		const command = boundary.commandInput
		if (
			insert instanceof z.ZodObject &&
			storage instanceof z.ZodObject &&
			command instanceof z.ZodObject
		) {
			insert.shape.name = z.string().min(5)
			storage.shape.name = z.string().min(5)
			command.shape.name = z.string().min(5)
		} else if (
			insert instanceof z.ZodDiscriminatedUnion &&
			storage instanceof z.ZodDiscriminatedUnion &&
			command instanceof z.ZodDiscriminatedUnion
		) {
			for (const option of [insert.options[0], storage.options[0], command.options[0]]) {
				if (!(option instanceof z.ZodObject)) throw new Error('Unexpected variant shape')
				option.shape.name = z.string().min(5)
			}
		} else throw new Error('Unexpected table shape')
		const row = kind === 'ordinary' ? { name: 'ok' } : { type: 'item', name: 'ok' }
		expect(boundary.updateSchema.safeParse(row).success).toBe(true)
		expect(boundary.schema.safeParse({ ...row, _id: 'items:1', _creationTime: 1 }).success).toBe(
			true,
		)
		expect(boundary.tools.update.safeParse({ id: 'items:1', data: row }).success).toBe(true)
	},
)

it('pagination observes schema field replacement after a prior call', () => {
	const boundary = zodTable('items', () => ({ name: z.string() }))
	const first = boundary.paginationOpts({ name: true })
	Object.assign(boundary.schema.shape, { name: z.number() })
	const second = boundary.paginationOpts({ name: true })
	const args = { numItems: 1, cursor: null, filters: { name: 42 } }
	expect(first.safeParse(args).success).toBe(false)
	expect(second.safeParse(args).success).toBe(true)
})

it('keeps eager boundary composition strict and independent after all first reads', () => {
	const boundary = zodTable('items', () => ({ name: z.string(), secret: z.string() }), {
		commandFields: ['name'],
		publicFields: ['name'],
	})
	const { schema, insertSchema, updateSchema, commandInput, publicDto, tools } = boundary
	const detail = publicDto.extend({ ownerId: schema.shape._id })
	const command = commandInput.superRefine(() => {})
	expect(detail.parse({ name: 'ok', ownerId: 'items:1' })).toEqual({
		name: 'ok',
		ownerId: 'items:1',
	})
	expect(command.parse({ name: 'ok' })).toEqual({ name: 'ok' })
	expect(updateSchema.safeParse({}).success).toBe(true)
	for (const validator of [schema, insertSchema, updateSchema, commandInput, publicDto]) {
		expect(validator.safeParse({ name: 'ok', unexpected: true }).success).toBe(false)
	}
	insertSchema.shape.name = z.string().min(5)
	commandInput.shape.name = z.string().min(5)
	boundary.storage.shape.name = z.string().min(5)
	expect(updateSchema.parse({ name: 'ok' })).toEqual({ name: 'ok' })
	expect(schema.parse({ name: 'ok', secret: 'hidden', _id: 'items:1', _creationTime: 1 })).toEqual({
		name: 'ok',
		secret: 'hidden',
		_id: 'items:1',
		_creationTime: 1,
	})
	expect(tools.update.parse({ id: 'items:1', data: { name: 'ok' } })).toEqual({
		id: 'items:1',
		data: { name: 'ok' },
	})
	const replacement = z.strictObject({ name: z.string().min(5) })
	boundary.publicDto = replacement
	expect(boundary.publicDto).toBe(replacement)
	expect(boundary.dto()).toBe(publicDto)
	expect(boundary.toPublicDto({ name: 'ok', secret: 'hidden' })).toEqual({ name: 'ok' })
})
