// Representative consumer app for the per-request module-load benchmark: ~30
// table boundaries (two variant tables), relations with joins, thunk domain
// contracts with compact relation pagination, and auth builders with triggers.
// Native table definitions (indexes) live in `appSchemaTables`, which only the
// schema module would import, mirroring how apps split `schema.ts` from
// per-domain `table.ts` files.
//
// This is the v2 (`k`) app. The v1 (Zod) app it is compared with is this file
// at commit 8d979a5, which `scripts/bench-app-load.mjs` extracts with
// `git archive`; it is translated field for field: `z.object` and
// `z.strictObject` become `k.object` (strict by default), `zid`/`id(...)`
// become `k.id(...)`, `zodTable`/`zodVariantTable` become `kTable`/`kVariantTable`,
// and Zod's `.pick({ a: true })` becomes `.pick('a')`.
import {
	actionGeneric,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	mutationGeneric,
	queryGeneric,
	type GenericDataModel,
} from 'convex/server'
import { Triggers } from 'convex-helpers/server/triggers'
import { k, type KType } from '../../src/k'
import { kTable, kVariantTable } from '../../src/table'
import { defineRelations } from '../../src/relations'
import { defineDomainContract } from '../../src/contracts'
import { createAuthFunctions } from '../../src/auth'

export const DOMAIN_COUNT = 28

function entity(name: string, parent: string) {
	return kTable(
		name,
		{
			parentId: k.id(parent).optional(),
			ownerId: k.id('entity0').optional(),
			ref: k.string(),
			status: k.enum(['open', 'closed', 'archived']),
			title: k.string().min(1).max(200),
			description: k.string().optional(),
			amountCents: k.number().int(),
			active: k.boolean(),
			tags: k.array(k.string()),
			details: k.object({ text: k.string(), notes: k.array(k.string()).optional() }),
			secret: k.string(),
		},
		{
			commandFields: ['title', 'status', 'ref', 'amountCents'],
			publicFields: [
				'parentId',
				'ownerId',
				'ref',
				'status',
				'title',
				'description',
				'amountCents',
				'active',
				'tags',
				'details',
			],
		},
	)
}

function variant(name: string) {
	return kVariantTable(
		name,
		k.discriminatedUnion('type', [
			k.object({
				type: k.literal('client_draft'),
				entityId: k.id('entity1'),
				amountCents: k.number().int(),
				scheduledDate: k.string(),
				memo: k.string().optional(),
			}),
			k.object({
				type: k.literal('creditor_payment'),
				entityId: k.id('entity1'),
				creditorId: k.id('entity2'),
				debtId: k.id('entity3'),
				amountCents: k.number().int(),
				scheduledDate: k.string(),
			}),
		]),
		{
			discriminator: 'type',
			variants: {
				client_draft: { publicFields: ['entityId', 'amountCents', 'scheduledDate', 'memo'] },
				creditor_payment: {
					publicFields: ['entityId', 'creditorId', 'debtId', 'amountCents', 'scheduledDate'],
				},
			},
		},
	)
}

export function defineAppTables() {
	const entities: Record<`entity${number}`, ReturnType<typeof entity>> = {}
	for (let i = 0; i < DOMAIN_COUNT; i++)
		entities[`entity${i}`] = entity(`entity${i}`, `entity${Math.max(0, i - 1)}`)
	const payments = variant('payments')
	const ledger = variant('ledger')
	return Object.assign(entities, { payments, ledger })
}

export type AppTables = ReturnType<typeof defineAppTables>

/** What `schema.ts` would build; function modules never import it. */
export function appSchemaTables(tables: AppTables) {
	const { payments, ledger, ...entities } = tables
	return {
		...Object.fromEntries(
			Object.entries(entities).map(([name, boundary]) => [
				name,
				boundary.table.index('by_parentId', ['parentId']).index('by_status', ['status']),
			]),
		),
		payments: payments.table.index('by_type_entityId', ['type', 'entityId']),
		ledger: ledger.table.index('by_type_entityId', ['type', 'entityId']),
	}
}

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Generated table names require an erased runtime fixture adapter; public APIs remain precisely typed.
type RuntimeBuilder = Record<string, any>
// SAFETY: runtime registration is identical for generated names; only the static types are erased.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- This fixture deliberately erases generated names.
const runtimeRelations = defineRelations as unknown as (
	tables: AppTables,
	declare: (r: RuntimeBuilder, branch: (table: string, tag: string) => RuntimeBuilder) => object,
) => { tables: RuntimeBuilder }

export function defineAppRelations(tables: AppTables) {
	return runtimeRelations(tables, (r, branch) => {
		// oxlint-disable-next-line anti-slop/no-known-value-widening, anti-slop/no-unsafe-dictionary-type -- Generated table names require an erased runtime adapter.
		const declarations: Record<string, Record<string, unknown>> = {
			entity1: {
				payments: r.many.payments({
					from: r.entity1._id,
					to: branch('payments', 'client_draft').entityId,
				}),
				ledger: r.many.ledger({
					from: r.entity1._id,
					to: branch('ledger', 'client_draft').entityId,
				}),
			},
		}
		for (let i = 1; i < DOMAIN_COUNT; i++)
			(declarations[`entity${i}`] ??= {}).parent = r.one[`entity${i - 1}`]({
				from: r[`entity${i}`].parentId,
				to: r[`entity${i - 1}`]._id,
			})
		for (let i = 1; i < 6; i++)
			(declarations[`entity${i}`] ??= {}).owner = r.one.entity0({
				from: r[`entity${i}`].ownerId,
				to: r.entity0._id,
			})
		return declarations
	})
}

type Section = Record<string, { input: KType; result: KType }>
type OperationBuilder = () => { input: KType; result: KType }

/**
 * Accord-shaped domain contract: commands over one entity, a detail query and
 * two compact relation-pagination list queries over the variant tables.
 * With `lazyOperations`, each operation is declared as a getter.
 */
export function defineAppContract(
	tables: AppTables,
	// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Erased runtime relation registry.
	relations: { tables: RuntimeBuilder },
	domain: `entity${number}`,
	lazyOperations: boolean,
) {
	const boundary = tables[domain]
	const id = k.object({ id: k.id(domain) })
	const ok = k.object({ ok: k.literal(true) })
	const commandBuilders: Record<string, OperationBuilder> = {}
	for (const verb of [
		'create',
		'rename',
		'archive',
		'restore',
		'assign',
		'schedule',
		'cancel',
		'approve',
		'reject',
	])
		commandBuilders[`${verb}Record`] = () => ({
			input:
				verb === 'create'
					? boundary.commandInput
					: k.object({
							id: k.id(domain),
							patch: boundary.updateSchema,
							reason: k.string().max(500).optional(),
						}),
			result: verb === 'create' ? id : ok,
		})
	// oxlint-disable-next-line anti-slop/no-known-value-widening -- Generated operation names; entries are built lazily.
	const queryBuilders: Record<string, OperationBuilder> = {
		getRecord: () => ({ input: id, result: boundary.publicDto.nullable() }),
		getPayment: () => ({
			input: k.object({ id: k.id('payments') }),
			result: tables.payments.dto(true),
		}),
		listPayments: () => ({
			input: relations.tables.payments
				.paginationOpts(
					{
						type: true,
						entityId: true,
						scheduledDate: true,
						variants: { creditor_payment: { creditorId: true, debtId: true } },
					},
					{ validator: 'compact' },
				)
				.pick('filters', 'order')
				.extend({ cursor: k.string().nullable(), numItems: k.number() }),
			result: relations.tables.payments.pageDto({}),
		}),
		listLedger: () => ({
			input: relations.tables.ledger
				.paginationOpts(
					{
						entityId: true,
						scheduledDate: true,
						variants: { creditor_payment: { creditorId: true, debtId: true } },
					},
					{ validator: 'compact' },
				)
				.pick('filters', 'order')
				.extend({ cursor: k.string().nullable(), numItems: k.number() }),
			result: relations.tables.ledger.pageDto({}),
		}),
		listRecords: () => ({
			input: relations.tables[domain].paginationOpts({ status: true, amountCents: true }),
			result: relations.tables[domain].pageDto({ parent: true }),
		}),
	}
	const section = (builders: Record<string, OperationBuilder>, classification?: string) => {
		const value: Section = {}
		for (const [key, build] of Object.entries(builders)) {
			const read = classification ? () => ({ ...build(), classification }) : build
			if (lazyOperations)
				Object.defineProperty(value, key, { enumerable: true, configurable: true, get: read })
			else value[key] = read()
		}
		return value
	}
	// SAFETY: generated operation names; the benchmark measures runtime cost only.
	// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Generated names erase the contract's static shape.
	return defineDomainContract((() => ({
		commands: section(commandBuilders, 'business'),
		queries: section(queryBuilders),
	})) as never) as unknown as { commands: Section; queries: Section }
}

export function defineAppAuth() {
	const triggers = new Triggers<GenericDataModel>()
	for (let i = 0; i < 6; i++) triggers.register(`entity${i}`, async () => {})
	return createAuthFunctions<GenericDataModel, 'admin' | 'member'>({
		query: queryGeneric,
		mutation: mutationGeneric,
		action: actionGeneric,
		internalQuery: internalQueryGeneric,
		internalMutation: internalMutationGeneric,
		internalAction: internalActionGeneric,
		getAuthUser: async (_ctx, identity) => ({ id: identity.subject }),
		mapRole: (slug) => (slug === 'admin' || slug === 'member' ? slug : null),
		adminRoles: ['admin'],
		triggers,
		security: { tenancy: { tables: ['entity0', 'entity1'] } },
	})
}
