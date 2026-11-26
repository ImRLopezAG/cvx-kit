import { defineSchema, defineTable } from 'convex/server'
import { defineTestApp } from 'convex-test'
import { v, type GenericId } from 'convex/values'
import { describe, expect, it } from 'vite-plus/test'

import { k, KValidationError, type KType } from '../src/k'
import { toJsonSchema } from '../src/json-schema'
import { kVariantTable } from '../src/table'

function idOf<Table extends string>(table: Table, value: string): GenericId<Table> {
	return k.id(table).parse(value)
}

const paymentStorage = k.discriminatedUnion('type', [
	k.object({
		type: k.literal('clientDraft'),
		clientId: k.id('clients'),
		amountCents: k.int().min(1),
		scheduledAt: k.int().min(0),
		providerEvidence: k.string().optional(),
	}),
	k.object({
		type: k.literal('creditorPayment'),
		clientId: k.id('clients'),
		creditorId: k.id('creditors'),
		amountCents: k.int().min(1),
		scheduledAt: k.int().min(0),
		providerEvidence: k.string().optional(),
	}),
])

const payments = kVariantTable('payments', paymentStorage, {
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
	clientId: idOf('clients', 'clients:1'),
	amountCents: 100,
	scheduledAt: 1,
}
const creditor = {
	...draft,
	type: 'creditorPayment' as const,
	creditorId: idOf('creditors', 'creditors:1'),
}

describe('kVariantTable boundaries', () => {
	it('stores a union of branch objects with a required literal discriminator', () => {
		const native = payments.storage.validator
		expect(native.kind).toBe('union')
		for (const branch of native.members) {
			expect(branch.kind).toBe('object')
			if (branch.kind !== 'object') continue
			expect(branch.fields.type).toMatchObject({ kind: 'literal', isOptional: 'required' })
			expect(branch.fields.clientId).toMatchObject({ kind: 'id', tableName: 'clients' })
			expect(branch.fields.createdAt.isOptional).toBe('optional')
		}
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

	it('fails parse at the discriminator path for an unknown tag', () => {
		const result = payments.storage.safeParse({ ...draft, type: 'missing' })
		expect(result.success).toBe(false)
		if (!result.success) expect(result.issues[0].path).toEqual(['type'])
	})

	it('updateSchema branches are partial except the tag', () => {
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
			expect(schema.safeParse({ type: 'clientDraft', amountCents: 0 }).success).toBe(false)
		}
		expect(payments.storage.safeParse({ ...draft, amountCents: undefined }).success).toBe(false)
	})

	it('adds system fields to the document and optional managed timestamps per branch', () => {
		const document = {
			...draft,
			_id: idOf('payments', 'payments:1'),
			_creationTime: 1,
			createdAt: 1,
		}
		expect(payments.schema.parse(document)).toEqual(document)
		expect(payments.storage.parse({ ...draft, createdAt: 1 })).toHaveProperty('createdAt', 1)
		expect(payments.storage.safeParse(document).success).toBe(false)
		expect(payments.schema.safeParse(draft).success).toBe(false)
	})

	it('projects the matching public branch and drops every other field', () => {
		for (const row of [draft, creditor]) {
			const stored = {
				...row,
				providerEvidence: 'private',
				createdAt: 1,
				_id: idOf('payments', 'payments:1'),
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
		expect(() => payments.toPublicDto({ ...draft, type: 'missing' })).toThrow(
			'Unknown variant discriminator "missing"',
		)
		// @ts-expect-error projection with an id requires an id-bearing row
		expect(() => payments.toPublicDto(draft, true)).toThrow(KValidationError)
		expect(payments.dto()).toBe(payments.publicDto)
		expect(payments.dto(true)).toBe(payments.dto(true))
	})

	it('keeps commands narrower than inserts and supports explicit public timestamps', () => {
		const table = kVariantTable('payments', paymentStorage, {
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

	it('keeps explicit timestamp fields and masks when managed timestamps are disabled', () => {
		const storage = k.discriminatedUnion('type', [
			k.object({
				type: k.literal('adjustment'),
				createdAt: k.int().min(0),
				updatedAt: k.int().min(0),
				archivedAt: k.int().min(0),
				recordedAt: k.int().min(0),
			}),
		])
		const variants = {
			adjustment: {
				serverFields: ['createdAt', 'updatedAt', 'archivedAt', 'recordedAt'],
				commandFields: [],
				publicFields: ['createdAt'],
			},
		} as const
		const table = kVariantTable('ledger', storage, {
			discriminator: 'type',
			timestamps: false,
			variants,
		})
		const row = {
			type: 'adjustment' as const,
			createdAt: 0,
			updatedAt: 1,
			archivedAt: 2,
			recordedAt: 3,
		}
		const document = { ...row, _id: idOf('ledger', 'ledger:1'), _creationTime: 0 }
		expect(table.storage.parse(row)).toEqual(row)
		expect(table.schema.parse(document)).toEqual(document)
		for (const key of ['createdAt', 'updatedAt', 'archivedAt', 'recordedAt'] as const) {
			for (const value of [undefined, -1, 0.5]) {
				expect(table.storage.safeParse({ ...row, [key]: value }).success).toBe(false)
				expect(table.schema.safeParse({ ...document, [key]: value }).success).toBe(false)
			}
			for (const schema of [
				table.commandInput,
				table.insertSchema,
				table.updateSchema,
				table.tools.insert,
				table.tools.update.shape.data,
			]) {
				expect(schema.parse({ type: 'adjustment' })).toEqual({ type: 'adjustment' })
				expect(schema.safeParse({ type: 'adjustment', [key]: 1 }).success).toBe(false)
			}
		}
		expect(table.toPublicDto(document)).toEqual({ type: 'adjustment', createdAt: 0 })
		expect(table.dto(true).parse(table.toPublicDto(document, true))).toEqual({
			type: 'adjustment',
			createdAt: 0,
			_id: document._id,
		})
		const native = table.storage.validator
		const [member] = native.members
		if (member.kind !== 'object') throw new Error('Expected an object branch')
		for (const key of ['createdAt', 'updatedAt', 'archivedAt', 'recordedAt'] as const)
			expect(member.fields[key]).toMatchObject({ kind: 'float64', isOptional: 'required' })
		for (const timestamps of [true, undefined])
			expect(() =>
				kVariantTable('ledger', storage, { discriminator: 'type', timestamps, variants }),
			).toThrow(/Reserved table field/)
	})

	it('uses ordinary writable masks for explicit timestamps without server ownership', () => {
		const table = kVariantTable(
			'ledger',
			k.discriminatedUnion('type', [
				k.object({ type: k.literal('adjustment'), createdAt: k.int().min(0) }),
			]),
			{
				discriminator: 'type',
				timestamps: false,
				variants: { adjustment: { commandFields: ['createdAt'], publicFields: [] } },
			},
		)
		for (const schema of [
			table.commandInput,
			table.insertSchema,
			table.updateSchema,
			table.tools.insert,
			table.tools.update.shape.data,
		]) {
			expect(schema.parse({ type: 'adjustment', createdAt: 1 })).toEqual({
				type: 'adjustment',
				createdAt: 1,
			})
			expect(schema.safeParse({ type: 'adjustment', createdAt: -1 }).success).toBe(false)
		}
		expect(table.insertSchema.safeParse({ type: 'adjustment' }).success).toBe(false)
		expect(table.updateSchema.parse({ type: 'adjustment' })).toEqual({ type: 'adjustment' })
		expect(table.toPublicDto({ type: 'adjustment', createdAt: 1 })).toEqual({ type: 'adjustment' })
		expect(
			table.storage.safeParse({ type: 'adjustment', createdAt: 1, updatedAt: 1 }).success,
		).toBe(false)
	})

	it('stores a native union whose branches keep table-branded ids and optional timestamps', () => {
		const native = payments.storage.validator
		expect(native.kind).toBe('union')
		for (const branch of native.members) {
			if (branch.kind !== 'object') throw new Error('Expected an object branch')
			expect(branch.fields.clientId).toMatchObject({ kind: 'id', tableName: 'clients' })
			expect(branch.fields.createdAt.isOptional).toBe('optional')
		}
	})

	it('keeps managed timestamp collisions and system fields reserved', () => {
		for (const key of ['createdAt', 'updatedAt', 'archivedAt', '_id', '_creationTime']) {
			const storage = k.discriminatedUnion('type', [
				k.object({ type: k.literal('adjustment'), ...Object.fromEntries([[key, k.int()]]) }),
			])
			expect(() =>
				kVariantTable('ledger', storage, {
					discriminator: 'type',
					timestamps: true,
					variants: { adjustment: {} },
				}),
			).toThrow(`Reserved table field "${key}" cannot be declared`)
			if (key === '_id' || key === '_creationTime')
				expect(() =>
					kVariantTable('ledger', storage, {
						discriminator: 'type',
						timestamps: false,
						variants: { adjustment: {} },
					}),
				).toThrow(`Reserved table field "${key}" cannot be declared`)
		}
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
			expect(() =>
				// SAFETY: exercise runtime validation for untyped JS callers.
				kVariantTable('payments', paymentStorage, { discriminator: 'type', variants } as never),
			).toThrow()
		}
		const branches: KType[] = [
			k.object({ type: k.enum(['draft', 'creditor']) }),
			k.object({ type: k.literal('draft'), createdAt: k.number() }),
			k.object({ type: k.literal('draft'), _id: k.string() }),
			k.object({ type: k.literal('draft'), field: k.string().transform((s) => s.length) }),
			k.object({ type: k.literal('draft'), field: k.string().trim() }),
			k.object({ type: k.literal('draft'), field: k.string().default('default') }),
			k.object({ type: k.literal('draft'), field: k.object({ nested: k.string().trim() }) }),
			k.object({ type: k.literal('draft') }).refine(() => true),
			k.object({ type: k.literal('draft') }).strip(),
		]
		for (const branch of branches) {
			expect(() =>
				kVariantTable(
					'payments',
					// SAFETY: deliberately unsupported branch grammars must fail with a diagnostic.
					k.discriminatedUnion('type', [branch as never]),
					// SAFETY: as above.
					{ discriminator: 'type', variants: { draft: {} } } as never,
				),
			).toThrow(/variant|reserved/i)
		}
		expect(() =>
			kVariantTable(
				'payments',
				k.discriminatedUnion('type', [
					k.object({ type: k.literal('draft') }),
					k.object({ type: k.literal('draft') }),
				]),
				{ discriminator: 'type', variants: { draft: {} } },
			),
		).toThrow(/more than one option has 'type' value "draft"/)
		expect(() =>
			// SAFETY: mismatched discriminators are rejected for JS callers as well.
			kVariantTable('payments', paymentStorage, { discriminator: 'kind', variants: {} } as never),
		).toThrow(/discriminator/i)
		expect(() =>
			kVariantTable(
				'payments',
				// SAFETY: a plain union is not a discriminated union, so boundary mode rejects it.
				k.union([k.object({ type: k.literal('a') }), k.object({ type: k.literal('b') })]) as never,
				// SAFETY: as above; the options cannot be typed against a non-discriminated union.
				{ discriminator: 'type', variants: { a: {}, b: {} } } as never,
			),
		).toThrow(/discriminated union/)
	})

	it('throws at definition when a branch omits the discriminator', () => {
		expect(() =>
			k.discriminatedUnion('type', [
				k.object({ type: k.literal('a') }),
				// SAFETY: a branch without the key is what this test rejects.
				k.object({ other: k.string() }) as never,
			]),
		).toThrow(/option 1 has no 'type' field/)
	})

	it('rejects bigint tool commands at construction and keeps storage-only bigints', () => {
		for (const value of [k.int64(), k.literal(1n), k.array(k.literal(1n)), k.int64().optional()]) {
			const storage = k.discriminatedUnion('type', [k.object({ type: k.literal('one'), value })])
			expect(() =>
				kVariantTable('rows', storage, {
					discriminator: 'type',
					variants: { one: { commandFields: ['value'] } },
				}),
			).toThrow(/bigint/)
			const serverOnly = kVariantTable('rows', storage, {
				discriminator: 'type',
				variants: { one: { serverFields: ['value'] } },
			})
			expect(() => toJsonSchema(serverOnly.tools.insert)).not.toThrow()
		}
	})

	it('renders ids as strings in tool JSON Schema while keeping native id validators', () => {
		const json = JSON.stringify(toJsonSchema(payments.tools.insert))
		expect(json).toContain('"clientId":{"type":"string"')
		expect(() => toJsonSchema(payments.tools.update)).not.toThrow()
		expect(payments.tools.id.validator.fields.id).toMatchObject({
			kind: 'id',
			tableName: 'payments',
		})
	})

	it('keeps checks on nested and wrapped tool fields', () => {
		const storage = k.discriminatedUnion('type', [
			k.object({
				type: k.literal('one'),
				name: k
					.string()
					.refine((value) => value !== 'blocked')
					.optional(),
				owners: k.array(k.id('clients').refine((id) => id !== 'clients:blocked')).min(1),
			}),
		])
		const table = kVariantTable('rows', storage, {
			discriminator: 'type',
			variants: { one: { commandFields: ['name', 'owners'] } },
		})
		for (const schema of [table.commandInput, table.tools.insert]) {
			expect(schema.safeParse({ type: 'one', name: 'ok', owners: ['clients:1'] }).success).toBe(
				true,
			)
			expect(
				schema.safeParse({ type: 'one', name: 'blocked', owners: ['clients:1'] }).success,
			).toBe(false)
			expect(schema.safeParse({ type: 'one', owners: [] }).success).toBe(false)
			expect(schema.safeParse({ type: 'one', owners: ['clients:blocked'] }).success).toBe(false)
		}
	})

	it('builds every boundary lazily and memoises it', () => {
		const tag = k.literal('lazy')
		const table = kVariantTable('lazy', k.discriminatedUnion('kind', [k.object({ kind: tag })]), {
			discriminator: 'kind',
			variants: { lazy: {} },
		})
		expect(table.tableName).toBe('lazy')
		expect(table.commandInput).toBe(table.commandInput)
		expect(tag.native).toBeUndefined()
		expect(table.table).toBe(table.table)
		expect(tag.native).toBeDefined()
	})
})

describe('kVariantTable legacy mode', () => {
	it('stores the schema as declared, with no derived boundaries', () => {
		const legacy = kVariantTable('payments', paymentStorage)
		expect(legacy.insertSchema).toBe(paymentStorage)
		expect(legacy.storage).toBe(paymentStorage)
		expect(legacy.tableName).toBe('payments')
		expect(legacy).not.toHaveProperty('commandInput')
		expect(legacy.insertSchema.parse({ ...draft, providerEvidence: 'internal' })).toHaveProperty(
			'providerEvidence',
			'internal',
		)
	})

	it('accepts a plain union of objects and builds the table on first read', () => {
		const tag = k.literal('x')
		const legacy = kVariantTable(
			'events',
			k.union([k.object({ kind: tag, x: k.number() }), k.object({ kind: k.literal('y') })]),
		)
		expect(tag.native).toBeUndefined()
		expect(legacy.table).toBe(legacy.table)
		expect(tag.native).toBeDefined()
	})

	it('rejects a transform in the stored schema', () => {
		expect(() =>
			kVariantTable(
				'events',
				// @ts-expect-error a transform cannot be stored
				k.union([k.object({ kind: k.literal('x'), x: k.string().transform(Number) }), k.null()]),
			),
		).toThrow(/transform or pipe/)
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
			args: { input: payments.commandInput.validator },
			returns: payments.dto(true).outputValidator,
			handler: async (ctx, args) => {
				const input = payments.commandInput.parse(args.input)
				const stored = payments.storage.parse({ ...input, providerEvidence: 'server evidence' })
				const _id = await ctx.db.insert('payments', stored)
				return payments.toPublicDto({ ...stored, _id }, true)
			},
		}),
		update: app.mutation({
			args: payments.tools.update.validator,
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
				// @ts-expect-error deliberately send a wrong-table id to the consumer
				id: clientId,
				data: { type: 'clientDraft', scheduledAt: 3 },
			}),
		).rejects.toThrow()
		const stored = await t.run((ctx) => ctx.db.get('payments', row._id))
		expect(stored).toMatchObject({ type: 'clientDraft', amountCents: 100, scheduledAt: 2 })
		expect(await t.run((ctx) => ctx.db.query('audits').take(10))).toHaveLength(1)
	})

	it('enforces wrong-branch fields and table-specific ids at the database boundary', async () => {
		const t = consumer.createTest()
		const clientId = await t.run((ctx) => ctx.db.insert('clients', { name: 'client' }))
		const creditorId = await t.run((ctx) => ctx.db.insert('creditors', { name: 'creditor' }))
		const contaminated = { ...draft, clientId, creditorId }
		await expect(t.run((ctx) => ctx.db.insert('payments', contaminated))).rejects.toThrow()
		await expect(
			// SAFETY: force a wrong-table id through TypeScript to test native storage validation.
			t.run((ctx) => ctx.db.insert('payments', { ...draft, clientId: creditorId as never })),
		).rejects.toThrow()
		expect(await t.run((ctx) => ctx.db.query('payments').take(10))).toEqual([])
	})
})
