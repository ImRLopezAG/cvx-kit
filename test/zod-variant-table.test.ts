import { describe, expect, it } from 'vite-plus/test'
import { defineSchema, defineTable } from 'convex/server'
import { defineTestApp } from 'convex-test'
import { v } from 'convex/values'
import { z } from 'zod'

import { defineRelations } from '../src/relations'
import { zid, zodToConvex, zodVariantTable } from '../src/zod-table'

export const paymentStorage = z.discriminatedUnion('type', [
	z.strictObject({
		type: z.literal('clientDraft'),
		clientId: zid('clients'),
		amountCents: z.int().positive(),
		scheduledAt: z.int().nonnegative(),
		providerEvidence: z.string().optional(),
	}),
	z.strictObject({
		type: z.literal('creditorPayment'),
		clientId: zid('clients'),
		creditorId: zid('creditors'),
		amountCents: z.int().positive(),
		scheduledAt: z.int().nonnegative(),
		providerEvidence: z.string().optional(),
	}),
])

export const payments = zodVariantTable('payments', paymentStorage, {
	discriminator: 'type',
	timestamps: true,
	variants: {
		clientDraft: {
			serverFields: ['providerEvidence'],
			commandFields: ['clientId', 'amountCents', 'scheduledAt'],
			publicFields: ['clientId', 'amountCents', 'scheduledAt'],
		},
		creditorPayment: {
			serverFields: ['providerEvidence'],
			commandFields: ['clientId', 'creditorId', 'amountCents', 'scheduledAt'],
			publicFields: ['clientId', 'creditorId', 'amountCents', 'scheduledAt'],
		},
	},
})

const draft = {
	type: 'clientDraft' as const,
	clientId: zid('clients').parse('clients:1'),
	amountCents: 100,
	scheduledAt: 1,
}
const creditor = {
	...draft,
	type: 'creditorPayment' as const,
	creditorId: zid('creditors').parse('creditors:1'),
}

describe('zodVariantTable boundaries', () => {
	it('keeps the two-argument helper unchanged', () => {
		const legacy = zodVariantTable('payments', paymentStorage)
		expect(legacy.insertSchema).toBe(paymentStorage)
		expect(legacy.storage).toBe(paymentStorage)
		expect(Object.keys(legacy).sort()).toEqual(['insertSchema', 'storage', 'table', 'tableName'])
		expect(legacy.insertSchema.parse({ ...draft, providerEvidence: 'internal' })).toHaveProperty(
			'providerEvidence',
			'internal',
		)
	})

	it('derives strict commands and inserts with literal discriminators', () => {
		for (const schema of [payments.commandInput, payments.insertSchema, payments.tools.insert]) {
			expect(schema.parse(draft)).toEqual(draft)
			expect(schema.parse(creditor)).toEqual(creditor)
			const { creditorId, ...missingCreditor } = creditor
			void creditorId
			expect(schema.safeParse(missingCreditor).success).toBe(false)
			for (const extra of [
				{ creditorId: creditor.creditorId },
				{ providerEvidence: 'private' },
				{ createdAt: 1 },
				{ updatedAt: 1 },
				{ archivedAt: 1 },
				{ _id: 'payments:1' },
				{ _creationTime: 1 },
			])
				expect(schema.safeParse({ ...draft, ...extra }).success).toBe(false)
			expect(schema.safeParse({ ...draft, type: undefined }).success).toBe(false)
			expect(schema.safeParse({ ...draft, type: 'missing' }).success).toBe(false)
		}
	})

	it('retains only the discriminator as required in partial patches', () => {
		for (const schema of [payments.updateSchema, payments.tools.update.shape.data]) {
			expect(schema.parse({ type: 'clientDraft', scheduledAt: 2 })).toEqual({
				type: 'clientDraft',
				scheduledAt: 2,
			})
			expect(schema.safeParse({ scheduledAt: 2 }).success).toBe(false)
			expect(
				schema.safeParse({ type: 'clientDraft', creditorId: creditor.creditorId }).success,
			).toBe(false)
			expect(schema.safeParse({ type: 'clientDraft', providerEvidence: 'private' }).success).toBe(
				false,
			)
			expect(schema.safeParse({ type: 'clientDraft', amountCents: undefined }).success).toBe(true)
			expect(payments.storage.safeParse({ ...draft, amountCents: undefined }).success).toBe(false)
		}
	})

	it('adds document/system fields and optional managed timestamps per branch', () => {
		const row = {
			...draft,
			_id: zid('payments').parse('payments:1'),
			_creationTime: 1,
			createdAt: 1,
		}
		expect(payments.schema.parse(row)).toEqual(row)
		expect(payments.storage.parse({ ...draft, createdAt: 1 })).toHaveProperty('createdAt', 1)
		expect(payments.storage.safeParse(row).success).toBe(false)
		expect(payments.schema.safeParse(draft).success).toBe(false)
	})

	it('projects the matching public branch before validating its DTO', () => {
		for (const row of [draft, creditor]) {
			const stored = {
				...row,
				providerEvidence: 'private',
				createdAt: 1,
				_id: zid('payments').parse('payments:1'),
				_creationTime: 1,
			}
			expect(payments.toPublicDto(stored)).toEqual(row)
			const dto = payments.toPublicDto(stored, true)
			expect(dto).toEqual({ ...row, _id: stored._id })
			expect(payments.dto(true).parse(dto)).toEqual(dto)
			expect(payments.publicDto.safeParse(stored).success).toBe(false)
		}
		const contaminated = { ...draft, creditorId: creditor.creditorId }
		expect(payments.toPublicDto(contaminated)).toEqual(draft)
		// @ts-expect-error unknown discriminators are also rejected at runtime
		expect(() => payments.toPublicDto({ ...draft, type: 'missing' })).toThrow()
		// @ts-expect-error projection with an ID requires an ID-bearing row
		expect(() => payments.toPublicDto(draft, true)).toThrow()
	})

	it('preserves native union shapes and table-branded ID validators', () => {
		const native = zodToConvex(payments.storage)
		expect(native.kind).toBe('union')
		if (native.kind !== 'union') throw new Error('Expected union')
		for (const branch of native.members) {
			if (branch.kind !== 'object') throw new Error('Expected object')
			expect(branch.fields.clientId.kind).toBe('id')
			if (branch.fields.clientId.kind === 'id')
				expect(branch.fields.clientId.tableName).toBe('clients')
			expect(branch.fields.createdAt.isOptional).toBe('optional')
		}
	})

	it('registers generated variant boundaries without an object facade', () => {
		const registry = defineRelations({ payments }, () => ({}))
		expect(registry.tables.payments).toBeDefined()
	})

	it('rejects malformed branch masks and unsupported schemas at construction', () => {
		for (const variants of [
			{ clientDraft: {} },
			{ clientDraft: {}, creditorPayment: {}, missing: {} },
			{ clientDraft: { commandFields: ['creditorId'] }, creditorPayment: {} },
			{ clientDraft: { publicFields: ['missing'] }, creditorPayment: {} },
			{ clientDraft: { serverFields: ['type'] }, creditorPayment: {} },
			{ clientDraft: { commandFields: ['type'] }, creditorPayment: {} },
			{ clientDraft: { publicFields: ['type'] }, creditorPayment: {} },
			{
				clientDraft: { serverFields: ['providerEvidence'], commandFields: ['providerEvidence'] },
				creditorPayment: {},
			},
			{ clientDraft: { publicFields: ['createdAt'] }, creditorPayment: {} },
		]) {
			// SAFETY: exercise runtime validation for untyped JS callers.
			expect(() =>
				zodVariantTable('payments', paymentStorage, { discriminator: 'type', variants } as never),
			).toThrow()
		}
		for (const branch of [
			z.object({ type: z.literal('draft') }),
			z.strictObject({ type: z.literal(['draft', 'creditor']) }),
			z.strictObject({ type: z.literal('draft'), createdAt: z.number() }),
			z.strictObject({ type: z.literal('draft'), _id: z.string() }),
			z.strictObject({ type: z.literal('draft'), field: z.string().transform((s) => s.length) }),
			z.strictObject({ type: z.literal('draft'), field: z.string().trim() }),
			z.strictObject({ type: z.literal('draft'), field: z.string().default('default') }),
			z.strictObject({
				type: z.literal('draft'),
				field: z.object({ nested: z.string().transform((s) => s.length) }),
			}),
			z.strictObject({ type: z.literal('draft') }).refine(() => true),
		]) {
			// SAFETY: deliberately unsupported branch grammars must fail with a diagnostic.
			expect(() =>
				zodVariantTable('payments', z.discriminatedUnion('type', [branch]), {
					discriminator: 'type',
					variants: { draft: {} },
				} as never),
			).toThrow(/variant|reserved/i)
		}
		expect(() =>
			zodVariantTable(
				'payments',
				z.discriminatedUnion('type', [
					z.strictObject({ type: z.literal('draft') }),
					z.strictObject({ type: z.literal('draft') }),
				]),
				{ discriminator: 'type', variants: { draft: {} } },
			),
		).toThrow(/duplicate/i)
		// SAFETY: mismatched discriminators are rejected for JS callers as well.
		expect(() =>
			zodVariantTable('payments', paymentStorage, { discriminator: 'kind', variants: {} } as never),
		).toThrow(/discriminator/i)
	})

	it('keeps commands narrower than inserts and supports explicit public timestamps', () => {
		const table = zodVariantTable('payments', paymentStorage, {
			discriminator: 'type',
			timestamps: true,
			variants: {
				clientDraft: { commandFields: ['scheduledAt'], publicFields: ['createdAt'] },
				creditorPayment: {},
			},
		})
		expect(table.commandInput.parse({ type: 'clientDraft', scheduledAt: 1 })).toEqual({
			type: 'clientDraft',
			scheduledAt: 1,
		})
		expect(table.commandInput.safeParse(draft).success).toBe(false)
		expect(table.insertSchema.parse(draft)).toEqual(draft)
		expect(
			table.tools.update.shape.data.safeParse({ type: 'clientDraft', amountCents: 1 }).success,
		).toBe(false)
		expect(table.updateSchema.safeParse({ type: 'clientDraft', amountCents: 1 }).success).toBe(true)
		expect(table.toPublicDto({ ...draft, createdAt: 1 })).toEqual({
			type: 'clientDraft',
			createdAt: 1,
		})
	})

	it('renders branded IDs as strings in tool JSON schemas', () => {
		const json = z.toJSONSchema(payments.tools.insert)
		expect(json.oneOf).toHaveLength(2)
		expect(JSON.stringify(json)).toContain('"clientId":{"type":"string"')
		expect(() => z.toJSONSchema(payments.tools.update)).not.toThrow()
	})

	it('converts nested tool IDs without weakening field checks', () => {
		const storage = z.discriminatedUnion('type', [
			z.strictObject({
				type: z.literal('nested'),
				object: z.strictObject({ id: zid('clients').nullable() }),
				array: z.array(zid('clients').refine((id) => id !== 'clients:blocked')).min(1),
				tuple: z.tuple([zid('clients'), z.string()]),
				record: z.record(z.string(), zid('clients')),
				required: zid('clients').optional().nonoptional(),
			}),
		])
		const table = zodVariantTable('nested', storage, {
			discriminator: 'type',
			variants: { nested: { commandFields: ['object', 'array', 'tuple', 'record', 'required'] } },
		})
		const row = {
			type: 'nested',
			object: { id: null },
			array: ['clients:1'],
			tuple: ['clients:1', 'name'],
			record: { owner: 'clients:1' },
			required: 'clients:1',
		}
		expect(table.tools.insert.parse(row)).toEqual(row)
		expect(table.tools.insert.safeParse({ ...row, array: [] }).success).toBe(false)
		expect(table.tools.insert.safeParse({ ...row, array: ['clients:blocked'] }).success).toBe(false)
		expect(table.tools.insert.safeParse({ ...row, required: undefined }).success).toBe(false)
		expect(() => z.toJSONSchema(table.tools.insert)).not.toThrow()
	})

	it('rejects unsupported catchalls and bigint tool commands at construction', () => {
		const catchall = z.discriminatedUnion('type', [
			z.strictObject({ type: z.literal('one'), owners: z.object({}).catchall(zid('clients')) }),
		])
		expect(() =>
			zodVariantTable('rows', catchall, {
				discriminator: 'type',
				variants: { one: { commandFields: ['owners'] } },
			}),
		).toThrow(/catchall/)
		const storage = z.discriminatedUnion('type', [
			z.strictObject({ type: z.literal('one'), value: z.bigint() }),
		])
		expect(() =>
			zodVariantTable('rows', storage, {
				discriminator: 'type',
				variants: { one: { commandFields: ['value'] } },
			}),
		).toThrow(/bigint/)
		const serverOnly = zodVariantTable('rows', storage, {
			discriminator: 'type',
			variants: { one: { serverFields: ['value'] } },
		})
		expect(serverOnly.storage.parse({ type: 'one', value: 1n })).toEqual({ type: 'one', value: 1n })
		expect(() => z.toJSONSchema(serverOnly.tools.insert)).not.toThrow()
	})

	it('rejects nested bigint literals in tools while retaining storage-only literals', () => {
		for (const value of [z.literal(1n), z.literal([1n, 2n]), z.array(z.literal(1n))]) {
			const storage = z.discriminatedUnion('type', [
				z.strictObject({ type: z.literal('one'), value }),
			])
			expect(() =>
				zodVariantTable('rows', storage, {
					discriminator: 'type',
					variants: { one: { commandFields: ['value'] } },
				}),
			).toThrow(/bigint/)
			const table = zodVariantTable('rows', storage, {
				discriminator: 'type',
				variants: { one: { serverFields: ['value'] } },
			})
			expect(() => z.toJSONSchema(table.tools.insert)).not.toThrow()
		}
	})

	it('preserves optional and nullable wrapper refinements in tools', () => {
		const storage = z.discriminatedUnion('type', [
			z.strictObject({
				type: z.literal('one'),
				name: z
					.string()
					.optional()
					.refine((value) => value !== 'blocked'),
				owner: zid('clients')
					.nullable()
					.refine((value) => value !== null),
			}),
		])
		const table = zodVariantTable('rows', storage, {
			discriminator: 'type',
			variants: { one: { commandFields: ['name', 'owner'] } },
		})
		for (const schema of [table.commandInput, table.tools.insert, table.tools.update.shape.data]) {
			expect(schema.safeParse({ type: 'one', name: 'allowed', owner: 'clients:1' }).success).toBe(
				true,
			)
			expect(schema.safeParse({ type: 'one', name: 'blocked', owner: 'clients:1' }).success).toBe(
				false,
			)
			expect(schema.safeParse({ type: 'one', owner: null }).success).toBe(false)
		}
		expect(() => z.toJSONSchema(table.tools.insert)).not.toThrow()
	})
})

const app = defineTestApp({
	schema: defineSchema({
		payments: payments.table,
		clients: defineTable({ name: v.string() }),
		creditors: defineTable({ name: v.string() }),
		audits: defineTable({ paymentId: v.id('payments') }),
	}),
})
const consumer = app.defineModules({
	payments: {
		create: app.mutation({
			args: { input: zodToConvex(payments.commandInput) },
			returns: zodToConvex(payments.dto(true)),
			handler: async (ctx, args) => {
				const input = payments.commandInput.parse(args.input)
				const stored = payments.storage.parse({ ...input, providerEvidence: 'server evidence' })
				const _id = await ctx.db.insert('payments', stored)
				return payments.toPublicDto({ ...stored, _id }, true)
			},
		}),
		update: app.mutation({
			args: zodToConvex(payments.tools.update),
			returns: v.null(),
			handler: async (ctx, args) => {
				const { id, data } = payments.tools.update.parse(args)
				const stored = await ctx.db.get('payments', id)
				if (!stored || stored.type !== data.type) throw new Error('Payment type cannot change')
				const { _id, _creationTime, ...storage } = stored
				void _creationTime
				payments.storage.parse({ ...storage, ...data })
				await ctx.db.patch('payments', _id, data)
				await ctx.db.insert('audits', { paymentId: _id })
				return null
			},
		}),
	},
})

describe('variant Convex consumer', () => {
	it('uses derived inputs and native return validators without exposing evidence', async () => {
		const t = consumer.createTest()
		const ids = await t.run(async (ctx) => ({
			clientId: await ctx.db.insert('clients', { name: 'client' }),
			creditorId: await ctx.db.insert('creditors', { name: 'creditor' }),
		}))
		for (const input of [
			{ ...draft, clientId: ids.clientId },
			{ ...creditor, ...ids },
		]) {
			const result = await t.mutation(consumer.api.payments.create, { input })
			expect(result).toMatchObject(input)
			expect(result).not.toHaveProperty('providerEvidence')
			const stored = await t.run((ctx) => ctx.db.get('payments', result._id))
			expect(stored?.providerEvidence).toBe('server evidence')
		}
	})

	it('validates complete merged rows and rejects conversions without write or audit effects', async () => {
		const t = consumer.createTest()
		const clientId = await t.run((ctx) => ctx.db.insert('clients', { name: 'client' }))
		const row = await t.mutation(consumer.api.payments.create, { input: { ...draft, clientId } })
		await t.mutation(consumer.api.payments.update, {
			id: row._id,
			data: { type: 'clientDraft', scheduledAt: 2 },
		})
		for (const data of [
			{ type: 'creditorPayment' as const, scheduledAt: 3 },
			{ type: 'clientDraft' as const, amountCents: -1 },
		])
			await expect(
				t.mutation(consumer.api.payments.update, { id: row._id, data }),
			).rejects.toThrow()
		await expect(
			t.mutation(consumer.api.payments.update, {
				// @ts-expect-error deliberately send a wrong-table ID to the consumer
				id: clientId,
				data: { type: 'clientDraft', scheduledAt: 3 },
			}),
		).rejects.toThrow()
		const stored = await t.run((ctx) => ctx.db.get('payments', row._id))
		expect(stored).toMatchObject({ type: 'clientDraft', amountCents: 100, scheduledAt: 2 })
		expect(await t.run((ctx) => ctx.db.query('audits').take(10))).toHaveLength(1)
		// Inline mutation retains explicit undefined; serialized function args omit it.
		await expect(
			t.mutation(async (ctx) => {
				const data = payments.updateSchema.parse({ type: 'clientDraft', amountCents: undefined })
				const current = await ctx.db.get('payments', row._id)
				if (!current || current.type !== data.type) throw new Error('Payment type cannot change')
				const { _id, _creationTime, ...storage } = current
				void _creationTime
				payments.storage.parse({ ...storage, ...data })
				await ctx.db.patch('payments', _id, data)
				await ctx.db.insert('audits', { paymentId: _id })
			}),
		).rejects.toThrow()
		expect(await t.run((ctx) => ctx.db.get('payments', row._id))).toEqual(stored)
		expect(await t.run((ctx) => ctx.db.query('audits').take(10))).toHaveLength(1)
	})

	it('enforces wrong-branch fields and table-specific IDs at the database boundary', async () => {
		const t = consumer.createTest()
		const clientId = await t.run((ctx) => ctx.db.insert('clients', { name: 'client' }))
		const creditorId = await t.run((ctx) => ctx.db.insert('creditors', { name: 'creditor' }))
		const contaminated = { ...draft, clientId, creditorId }
		await expect(t.run((ctx) => ctx.db.insert('payments', contaminated))).rejects.toThrow()
		// SAFETY: force a wrong-table ID through TypeScript to test native storage validation.
		await expect(
			t.run((ctx) => ctx.db.insert('payments', { ...draft, clientId: creditorId as never })),
		).rejects.toThrow()
		expect(await t.run((ctx) => ctx.db.query('payments').take(10))).toEqual([])
	})
})
