import { z } from 'zod'
import { zid } from 'convex-helpers/server/zod4'
import { defineSchema, type DataModelFromSchemaDefinition } from 'convex/server'
import { defineTestApp } from 'convex-test'
import { zodTable, zodVariantTable } from '../../src/zod-table'
import { defineRelations } from '../../src/relations-public'
import { createQueryEngine } from '../../src/querying'
import { cursor, managed, observed } from './scalar'

export function variantEdgesFixture() {
	const creditors = zodTable('creditors', () => ({ name: z.string() }), { publicFields: ['name'] })
	const payments = zodVariantTable(
		'payments',
		z.discriminatedUnion('type', [
			z.strictObject({
				type: z.literal('creditor'),
				creditorId: zid('creditors'),
				amount: z.number(),
			}),
			z.strictObject({
				type: z.literal('draft'),
				creditorId: zid('creditors'),
				amount: z.number(),
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
	const links = zodVariantTable(
		'links',
		z.discriminatedUnion('type', [
			z.strictObject({
				type: z.literal('attachment'),
				paymentId: zid('payments'),
				code: z.string(),
			}),
			z.strictObject({ type: z.literal('other'), paymentId: zid('payments'), code: z.string() }),
		]),
		{ discriminator: 'type', variants: { attachment: {}, other: {} } },
	)
	links.table.index('by_type_paymentId', ['type', 'paymentId'])
	const attachments = zodVariantTable(
		'attachments',
		z.discriminatedUnion('type', [
			z.strictObject({ type: z.literal('file'), code: z.string(), name: z.string() }),
			z.strictObject({ type: z.literal('other'), code: z.string(), name: z.string() }),
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
