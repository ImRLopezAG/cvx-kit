// v2 (`k`) side of the whole-request benchmark: the same app as v1-fixture.ts,
// translated field for field. `z.object`/`z.strictObject` become `k.object`
// (strict by default), `zid`/`id(...)` become `k.id(...)`.
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
import { k } from '../../../src/k'
import { kTable, kVariantTable } from '../../../src/table'
import { createKAuthFunctions } from '../../../src/auth'
import type { Operation } from './register'

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

export function defineAppAuth() {
	const triggers = new Triggers<GenericDataModel>()
	for (let i = 0; i < 6; i++) triggers.register(`entity${i}`, async () => {})
	return createKAuthFunctions<GenericDataModel, 'admin' | 'member'>({
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

/** The five operations of one domain; each declaration is built when its thunk runs. */
export function defineOperations(tables: ReturnType<typeof defineAppTables>) {
	const table = tables.entity1
	const id = () => k.id('entity1')
	return {
		create: { kind: 'mutation', args: () => table.commandInput, returns: () => table.dto(true) },
		update: {
			kind: 'mutation',
			args: () => ({ id: id(), patch: table.updateSchema }),
			returns: () => k.null(),
		},
		get: { kind: 'query', args: () => ({ id: id() }), returns: () => table.publicDto.nullable() },
		list: {
			kind: 'query',
			args: () => ({
				status: k.enum(['open', 'closed', 'archived']).optional(),
				limit: k.number().optional(),
			}),
			returns: () => k.array(table.publicDto),
		},
		archive: { kind: 'mutation', args: () => ({ id: id() }), returns: () => k.null() },
	} satisfies Record<string, Operation>
}
