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
