import { k } from '../../src/k'
import { defineSchema, type DataModelFromSchemaDefinition } from 'convex/server'
import { defineTestApp } from 'convex-test'
import { kTable, kVariantTable } from '../../src/table'
import { defineRelations } from '../../src/relations-public'
import { createQueryEngine } from '../../src/querying'
import { cursor, managed, observed } from './scalar'

export function variantEdgesFixture() {
	const creditors = kTable('creditors', { name: k.string() }, { publicFields: ['name'] })
	const payments = kVariantTable(
		'payments',
		k.discriminatedUnion('type', [
			k.object({
				type: k.literal('creditor'),
				creditorId: k.id('creditors'),
				amount: k.number(),
			}),
			k.object({
				type: k.literal('draft'),
				creditorId: k.id('creditors'),
				amount: k.number(),
			}),
		]),
		{
			discriminator: 'type',
			variants: {
				creditor: { publicFields: ['creditorId', 'amount'] },
				draft: { publicFields: ['creditorId', 'amount'] },
			},
		},
	)
	// No leading creditorId index: every relation lookup must bind the guard prefix.
	payments.table.index('by_type_creditorId', ['type', 'creditorId'])
	const links = kVariantTable(
		'links',
		k.discriminatedUnion('type', [
			k.object({
				type: k.literal('attachment'),
				paymentId: k.id('payments'),
				code: k.string(),
			}),
			k.object({ type: k.literal('other'), paymentId: k.id('payments'), code: k.string() }),
		]),
		{ discriminator: 'type', variants: { attachment: {}, other: {} } },
	)
	links.table.index('by_type_paymentId', ['type', 'paymentId'])
	const attachments = kVariantTable(
		'attachments',
		k.discriminatedUnion('type', [
			k.object({ type: k.literal('file'), code: k.string(), name: k.string() }),
			k.object({ type: k.literal('other'), code: k.string(), name: k.string() }),
		]),
		{
			discriminator: 'type',
			variants: {
				file: { publicFields: ['code', 'name'] },
				other: { publicFields: ['code', 'name'] },
			},
		},
	)
	attachments.table.index('by_type_code', ['type', 'code'])
	const relations = defineRelations({ creditors, payments, links, attachments }, (r, branch) => ({
		creditors: {
			payments: r.many.payments({
				from: r.creditors._id,
				to: branch('payments', 'creditor').creditorId,
			}),
		},
		payments: {
			attachments: r.many.attachments({
				from: r.payments._id.through(branch('links', 'attachment').paymentId),
				to: branch('attachments', 'file').code.through(branch('links', 'attachment').code),
			}),
		},
	}))
	const schema = defineSchema({
		creditors: creditors.table,
		payments: payments.table,
		links: links.table,
		attachments: attachments.table,
	})
	const { createTest } = defineTestApp({ schema }).defineModules({})
	type DM = DataModelFromSchemaDefinition<typeof schema>
	return {
		relations,
		schema,
		t: createTest(),
		querying: createQueryEngine({ schema, relations }, { cursor }),
		context(db: Parameters<typeof observed<DM>>[0]) {
			const o = observed(db)
			return { ...o, ctx: managed(o.raw) }
		},
	}
}
