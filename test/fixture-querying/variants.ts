import { z } from 'zod'
import { zid } from 'convex-helpers/server/zod4'
import {
	defineSchema,
	type DataModelFromSchemaDefinition,
	type GenericDatabaseReader,
	type GenericDataModel,
	type GenericTableInfo,
	type QueryInitializer,
} from 'convex/server'
import { defineTestApp } from 'convex-test'
import { zodTable, zodVariantTable } from '../../src/zod-table'
import { defineRelations } from '../../src/relations-public'
import { createQueryEngine } from '../../src/querying'
import { cursor, managed, observed, scope } from './scalar'

/** Attacker-only transport: real native ordering/iteration, one corrupted stored payload. */
export function corruptVariantRow<Model extends GenericDataModel>(
	reader: GenericDatabaseReader<Model>,
	id: string,
	patch: { type?: string; draftDate?: number; creditorId?: string; paymentId?: string },
) {
	const corrupt = <Row extends Record<string, unknown>>(row: Row): Row => {
		if (row._id !== id) return row
		const result = { ...row, ...patch }
		for (const [key, value] of Object.entries(patch))
			if (value === undefined) Reflect.deleteProperty(result, key)
		// SAFETY: malicious storage payload deliberately violates the native row contract.
		return result as Row
	}
	function query<T extends GenericTableInfo>(source: QueryInitializer<T>): QueryInitializer<T> {
		return new Proxy(source, {
			get(target, key) {
				if (key === Symbol.asyncIterator)
					return () => {
						const inner = target[Symbol.asyncIterator]()
						return {
							next: async () => {
								const item = await inner.next()
								return item.done ? item : { ...item, value: corrupt(item.value) }
							},
							return: () => inner.return!(),
						}
					}
				if (['withIndex', 'order', 'fullTableScan'].includes(String(key)))
					return (...args: never[]) => {
						// SAFETY: only native fluent methods are forwarded; no query behavior is synthesized.
						const fluent = target[key as 'withIndex' | 'order' | 'fullTableScan'] as (
							...args: never[]
						) => QueryInitializer<T>
						return query(fluent.apply(target, args))
					}
				// SAFETY: native query properties are forwarded unchanged.
				const value = target[key as keyof QueryInitializer<T>]
				return value instanceof Function ? value.bind(target) : value
			},
		})
	}
	const raw: GenericDatabaseReader<Model> = {
		...reader,
		query: (table) => query(reader.query(table)),
		get: async (...args: Parameters<typeof reader.get>) => {
			const row = await reader.get(...args)
			return row ? corrupt(row) : row
		},
		normalizeId: reader.normalizeId.bind(reader),
		system: reader.system,
	}
	return raw
}

export function variantDeclarations() {
	const clients = zodTable('clients', () => ({ name: z.string(), allowed: z.boolean() }), {
		publicFields: ['name'],
	})
	const creditors = zodTable('creditors', () => ({ name: z.string(), allowed: z.boolean() }), {
		publicFields: ['name'],
	})
	const payments = zodVariantTable(
		'payments',
		z.discriminatedUnion('type', [
			z.strictObject({
				type: z.literal('client_draft'),
				clientId: zid('clients'),
				amountCents: z.int().positive(),
				draftDate: z.int().nonnegative(),
				allowed: z.boolean(),
				external: z.strictObject({ providerId: z.string() }).optional(),
			}),
			z.strictObject({
				type: z.literal('creditor_payment'),
				clientId: zid('clients'),
				creditorId: zid('creditors'),
				amountCents: z.int().positive(),
				allowed: z.boolean(),
				external: z.strictObject({ providerId: z.string() }).optional(),
			}),
		]),
		{
			discriminator: 'type',
			timestamps: true,
			variants: {
				client_draft: {
					serverFields: ['allowed', 'external'],
					commandFields: ['clientId', 'amountCents', 'draftDate'],
					publicFields: ['clientId', 'amountCents', 'draftDate'],
				},
				creditor_payment: {
					serverFields: ['allowed', 'external'],
					commandFields: ['clientId', 'creditorId', 'amountCents'],
					publicFields: ['clientId', 'creditorId', 'amountCents'],
				},
			},
		},
	)
	payments.table
		.index('by_clientId', ['clientId'])
		.index('by_type_clientId', ['type', 'clientId'])
		.index('by_creditorId', ['creditorId'])
	const ledger = zodVariantTable(
		'ledger',
		z.discriminatedUnion('type', [
			z.strictObject({
				type: z.literal('payment_entry'),
				paymentId: zid('payments').optional(),
				creditorId: zid('creditors').optional(),
				allowed: z.boolean(),
			}),
			z.strictObject({ type: z.literal('adjustment'), amountCents: z.int(), allowed: z.boolean() }),
		]),
		{
			discriminator: 'type',
			variants: {
				payment_entry: { serverFields: ['allowed'], publicFields: ['paymentId', 'creditorId'] },
				adjustment: { serverFields: ['allowed'], publicFields: ['amountCents'] },
			},
		},
	)
	const attachments = zodTable(
		'attachments',
		() => ({ name: z.string(), allowed: z.boolean(), evidence: z.string() }),
		{ publicFields: ['name'] },
	)
	const paymentAttachments = zodTable(
		'paymentAttachments',
		(id) => ({ paymentId: id('payments'), attachmentId: id('attachments'), allowed: z.boolean() }),
		{ publicFields: [] },
	)
	paymentAttachments.table.index('by_paymentId', ['paymentId'])
	return { clients, creditors, payments, ledger, attachments, paymentAttachments }
}

export function variantFixture() {
	const tables = variantDeclarations()
	const { clients, creditors, payments, ledger, attachments, paymentAttachments } = tables
	const relations = defineRelations(tables, (r, branch) => ({
		clients: { payments: r.many.payments({ from: r.clients._id, to: r.payments.clientId }) },
		creditors: {
			payments: r.many.payments({
				from: r.creditors._id,
				to: branch('payments', 'creditor_payment').creditorId,
			}),
		},
		payments: {
			client: r.one.clients({ from: r.payments.clientId, to: r.clients._id }),
			creditor: r.one.creditors({
				from: branch('payments', 'creditor_payment').creditorId,
				to: r.creditors._id,
			}),
			attachments: r.many.attachments({
				from: r.payments._id.through(r.paymentAttachments.paymentId),
				to: r.attachments._id.through(r.paymentAttachments.attachmentId),
			}),
		},
		ledger: {
			payment: r.one.payments({
				from: branch('ledger', 'payment_entry').paymentId,
				to: r.payments._id,
			}),
			creditor: r.one.creditors({
				from: branch('ledger', 'payment_entry').creditorId,
				to: r.creditors._id,
			}),
		},
	}))
	const schema = defineSchema({
		clients: clients.table,
		creditors: creditors.table,
		payments: payments.table,
		ledger: ledger.table,
		attachments: attachments.table,
		paymentAttachments: paymentAttachments.table,
	})
	const { createTest } = defineTestApp({ schema }).defineModules({})
	const t = createTest()
	const querying = createQueryEngine({ schema, relations }, { cursor })
	type DM = DataModelFromSchemaDefinition<typeof schema>
	const context = (
		db: Parameters<typeof observed<DM>>[0],
		principal = scope.principal,
		finance = true,
	) => {
		const o = observed(db)
		return {
			...o,
			ctx: managed(
				o.raw,
				{
					clients: { read: async (_, row) => row.allowed },
					creditors: { read: async (_, row) => row.allowed },
					payments: { read: async (_, row) => finance && row.allowed },
					ledger: { read: async (_, row) => finance && row.allowed },
					attachments: { read: async (_, row) => row.allowed },
					paymentAttachments: { read: async (_, row) => row.allowed },
				},
				'deny',
				{ ...scope, principal },
			),
		}
	}
	return { ...tables, schema, relations, t, querying, context }
}

export async function seedVariants(f: ReturnType<typeof variantFixture>) {
	return f.t.run(async (ctx) => {
		const client = await ctx.db.insert('clients', { name: 'Client', allowed: true })
		const creditor = await ctx.db.insert('creditors', { name: 'Creditor', allowed: true })
		const payments = []
		for (let n = 0; n < 8; n++) {
			const common = {
				clientId: client,
				amountCents: n + 1,
				allowed: n !== 1 && n !== 4,
				external: { providerId: 'PRIVATE-EVIDENCE' },
				createdAt: n,
				updatedAt: n,
			}
			const command = f.payments.commandInput.parse(
				n % 2
					? { type: 'creditor_payment', clientId: client, amountCents: n + 1, creditorId: creditor }
					: { type: 'client_draft', clientId: client, amountCents: n + 1, draftDate: n },
			)
			const storage = f.payments.storage.parse({ ...common, ...command })
			const id = await ctx.db.insert('payments', storage)
			payments.push((await ctx.db.get(id))!)
		}
		return { client, creditor, payments }
	})
}
