import { z } from 'zod'
import { zid } from 'convex-helpers/server/zod4'
import {
	defineSchema,
	type DataModelFromSchemaDefinition,
	type GenericDatabaseReader,
} from 'convex/server'
import { defineTestApp } from 'convex-test'
import { v } from 'convex/values'
import { zodTable, zodVariantTable, zodToConvex } from '../../src/zod-table'
import { defineRelations } from '../../src/relations-public'
import { createQueryEngine } from '../../src/querying'
import type {
	ManagedBudgets,
	ManagedScope,
	SecurityPolicyContext,
} from '../../src/querying/security'
import type { Rules } from '../../src/tenancy'
import { cursor, managed, observed, scope } from './scalar'

export const members = [
	'tasks',
	'leads',
	'contacts',
	'clients',
	'creditors',
	'deals',
	'payments',
	'ledger',
] as const
export function idUnionTables() {
	const tasks = zodTable(
		'tasks',
		(id) => ({
			ordinal: z.number(),
			status: z.string(),
			allowed: z.boolean(),
			department: z.string(),
			secret: z.string(),
			rel: z
				.union([
					id('tasks'),
					id('leads'),
					id('contacts'),
					id('clients'),
					id('creditors'),
					id('deals'),
					id('payments'),
					id('ledger'),
				])
				.nullable()
				.optional(),
		}),
		{ publicFields: ['ordinal', 'status', 'rel'] },
	)
	tasks.table.index('by_rel', ['rel']).index('by_rel_status', ['rel', 'status'])
	const fields = () => ({
		name: z.string(),
		allowed: z.boolean(),
		department: z.string(),
		secret: z.string(),
	})
	const leads = zodTable('leads', fields, { publicFields: ['name'] })
	const contacts = zodTable('contacts', fields, { publicFields: ['name'] })
	const clients = zodTable('clients', fields, { publicFields: ['name'] })
	const creditors = zodTable('creditors', fields, { publicFields: ['name'] })
	const deals = zodTable('deals', (id) => ({ ...fields(), clientId: id('clients') }), {
		publicFields: ['name'],
	})
	const payments = zodVariantTable(
		'payments',
		z.discriminatedUnion('type', [
			z.strictObject({
				type: z.literal('posted'),
				...fields(),
				clientId: zid('clients'),
				amount: z.number(),
			}),
			z.strictObject({
				type: z.literal('draft'),
				...fields(),
				clientId: zid('clients'),
				memo: z.string(),
			}),
		]),
		{
			discriminator: 'type',
			variants: {
				posted: { publicFields: ['name', 'amount'] },
				draft: { publicFields: ['name', 'memo'] },
			},
		},
	)
	const ledger = zodVariantTable(
		'ledger',
		z.discriminatedUnion('type', [
			z.strictObject({
				type: z.literal('debit'),
				...fields(),
				clientId: zid('clients'),
				amount: z.number(),
			}),
			z.strictObject({
				type: z.literal('credit'),
				...fields(),
				clientId: zid('clients'),
				reason: z.string(),
			}),
		]),
		{
			discriminator: 'type',
			variants: {
				debit: { publicFields: ['name', 'amount'] },
				credit: { publicFields: ['name', 'reason'] },
			},
		},
	)
	return { tasks, leads, contacts, clients, creditors, deals, payments, ledger }
}
export function idUnionRelations(
	tables: ReturnType<typeof idUnionTables>,
	member: 'tasks' | 'clients' = 'tasks',
) {
	return defineRelations(tables, (r, branch) => ({
		tasks: {
			referenceTask: r.one.tasks({ from: r.tasks.rel.forTable('tasks'), to: r.tasks._id }),
			referencingTasks: r.many.tasks({ from: r.tasks._id, to: r.tasks.rel.forTable('tasks') }),
			lead: r.one.leads({ from: r.tasks.rel.forTable('leads'), to: r.leads._id }),
			contact: r.one.contacts({ from: r.tasks.rel.forTable('contacts'), to: r.contacts._id }),
			client: r.one.clients({ from: r.tasks.rel.forTable('clients'), to: r.clients._id }),
			creditor: r.one.creditors({ from: r.tasks.rel.forTable('creditors'), to: r.creditors._id }),
			deal: r.one.deals({ from: r.tasks.rel.forTable('deals'), to: r.deals._id }),
			payment: r.one.payments({ from: r.tasks.rel.forTable('payments'), to: r.payments._id }),
			postedPayment: r.one.payments({
				from: r.tasks.rel.forTable('payments'),
				to: branch('payments', 'posted')._id,
			}),
			ledgerEntry: r.one.ledger({ from: r.tasks.rel.forTable('ledger'), to: r.ledger._id }),
			debitEntry: r.one.ledger({
				from: r.tasks.rel.forTable('ledger'),
				to: branch('ledger', 'debit')._id,
			}),
			// Same source/target/name with only member metadata changed: identity regression.
			selected: r.one.tasks({
				from: r.tasks.rel.forTable(member),
				to: r.tasks.rel.forTable(member),
			}),
			selectedTasks: r.many.tasks({
				from: r.tasks.rel.forTable(member),
				to: r.tasks.rel.forTable(member),
			}),
		},
		leads: { tasks: r.many.tasks({ from: r.leads._id, to: r.tasks.rel.forTable('leads') }) },
		contacts: {
			tasks: r.many.tasks({ from: r.contacts._id, to: r.tasks.rel.forTable('contacts') }),
		},
		clients: { tasks: r.many.tasks({ from: r.clients._id, to: r.tasks.rel.forTable('clients') }) },
		creditors: {
			tasks: r.many.tasks({ from: r.creditors._id, to: r.tasks.rel.forTable('creditors') }),
		},
		deals: {
			tasks: r.many.tasks({ from: r.deals._id, to: r.tasks.rel.forTable('deals') }),
			client: r.one.clients({ from: r.deals.clientId, to: r.clients._id }),
		},
		payments: {
			tasks: r.many.tasks({ from: r.payments._id, to: r.tasks.rel.forTable('payments') }),
			postedTasks: r.many.tasks({
				from: branch('payments', 'posted')._id,
				to: r.tasks.rel.forTable('payments'),
			}),
			client: r.one.clients({ from: r.payments.clientId, to: r.clients._id }),
		},
		ledger: {
			tasks: r.many.tasks({ from: r.ledger._id, to: r.tasks.rel.forTable('ledger') }),
			client: r.one.clients({ from: r.ledger.clientId, to: r.clients._id }),
		},
	}))
}
export type IdUnionDM = DataModelFromSchemaDefinition<ReturnType<typeof idUnionSchema>>
export function idUnionSchema(tables: ReturnType<typeof idUnionTables>) {
	return defineSchema({
		tasks: tables.tasks.table,
		leads: tables.leads.table,
		contacts: tables.contacts.table,
		clients: tables.clients.table,
		creditors: tables.creditors.table,
		deals: tables.deals.table,
		payments: tables.payments.table,
		ledger: tables.ledger.table,
	})
}
export function idUnionFixture(budgets?: Partial<ManagedBudgets>) {
	const tables = idUnionTables(),
		relations = idUnionRelations(tables),
		schema = idUnionSchema(tables)
	const base = defineTestApp({ schema })
	const querying = createQueryEngine({ schema, relations }, { cursor, budgets })
	function context(
		db: GenericDatabaseReader<IdUnionDM>,
		authority: ManagedScope = scope,
		extraRules: Rules<SecurityPolicyContext<IdUnionDM>, IdUnionDM> = {},
	) {
		const o = observed(db)
		const read = async (
			_: SecurityPolicyContext<IdUnionDM>,
			row: { allowed: boolean; department: string },
		) => row.allowed && row.department === 'a'
		return {
			...o,
			ctx: managed(
				o.raw,
				{
					tasks: { read },
					leads: { read },
					contacts: { read },
					clients: { read },
					creditors: { read },
					deals: { read },
					payments: { read },
					ledger: { read },
					...extraRules,
				},
				'deny',
				authority,
			),
		}
	}
	const selection = {
		referenceTask: true,
		referencingTasks: true,
		client: { tasks: true },
		payment: true,
		ledgerEntry: true,
	} as const
	const app = base.defineModules({
		functions: {
			page: base.query({
				args: {
					input: zodToConvex(
						relations.tables.tasks.paginationOpts({
							ordinal: true,
							referenceTask: { status: true },
							client: { name: true },
						}),
					),
				},
				returns: zodToConvex(relations.tables.tasks.pageDto(selection)),
				handler: (ctx, { input }) =>
					querying(context(ctx.db).ctx).tasks.with(selection).paginate(input),
			}),
			nextTasks: base.query({
				args: {
					parent: v.id('tasks'),
					input: zodToConvex(relations.tables.tasks.paginationOpts({ status: true })),
				},
				returns: zodToConvex(relations.tables.tasks.pageDto({})),
				handler: (ctx, { parent, input }) =>
					querying(context(ctx.db).ctx).tasks.relation(parent, 'client.tasks').paginate(input),
			}),
			nextClients: base.query({
				args: {
					parent: v.id('clients'),
					input: zodToConvex(relations.tables.tasks.paginationOpts({ status: true })),
				},
				returns: zodToConvex(relations.tables.tasks.pageDto({})),
				handler: (ctx, { parent, input }) =>
					querying(context(ctx.db).ctx).clients.relation(parent, 'tasks').paginate(input),
			}),
		},
	})
	return { tables, relations, schema, t: app.createTest(), api: app.api, querying, context }
}
export const targetFields = {
	name: 'Public',
	allowed: true,
	department: 'a',
	secret: 'TARGET SECRET',
}
export const taskFields = {
	ordinal: 0,
	status: 'open',
	allowed: true,
	department: 'a',
	secret: 'TASK SECRET',
}
export async function seedIdUnions(f: ReturnType<typeof idUnionFixture>) {
	return f.t.run(async (ctx) => {
		const tasks = await ctx.db.insert('tasks', taskFields)
		const leads = await ctx.db.insert('leads', targetFields)
		const contacts = await ctx.db.insert('contacts', targetFields)
		const clients = await ctx.db.insert('clients', targetFields)
		const creditors = await ctx.db.insert('creditors', targetFields)
		const deals = await ctx.db.insert('deals', { ...targetFields, clientId: clients })
		const payments = await ctx.db.insert('payments', {
			...targetFields,
			type: 'posted',
			clientId: clients,
			amount: 5,
		})
		const ledger = await ctx.db.insert('ledger', {
			...targetFields,
			type: 'debit',
			clientId: clients,
			amount: 5,
		})
		const targets = { tasks, leads, contacts, clients, creditors, deals, payments, ledger }
		const links = []
		for (const [ordinal, member] of members.entries())
			links.push(
				await ctx.db.insert('tasks', { ...taskFields, ordinal: ordinal + 1, rel: targets[member] }),
			)
		return { targets, links }
	})
}
