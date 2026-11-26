// v1 (Zod) side of the whole-request benchmark: the table boundaries and auth
// builders of scripts/bench/app-fixture.ts, without relations or contracts,
// which have no `k` counterpart yet. v2-fixture.ts declares the same app on `k`.
import { z } from 'zod'
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
import { zid, zodTable, zodVariantTable } from '../../../src/zod-table'
import { createAuthFunctions } from '../../../src/auth'
import type { Operation } from './register'

export const DOMAIN_COUNT = 28

function entity(name: string, parent: string) {
	return zodTable(
		name,
		(id) => ({
			parentId: id(parent).optional(),
			ownerId: id('entity0').optional(),
			ref: z.string(),
			status: z.enum(['open', 'closed', 'archived']),
			title: z.string().min(1).max(200),
			description: z.string().optional(),
			amountCents: z.number().int(),
			active: z.boolean(),
			tags: z.array(z.string()),
			details: z.object({ text: z.string(), notes: z.array(z.string()).optional() }),
			secret: z.string(),
		}),
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
	return zodVariantTable(
		name,
		z.discriminatedUnion('type', [
			z.strictObject({
				type: z.literal('client_draft'),
				entityId: zid('entity1'),
				amountCents: z.number().int(),
				scheduledDate: z.string(),
				memo: z.string().optional(),
			}),
			z.strictObject({
				type: z.literal('creditor_payment'),
				entityId: zid('entity1'),
				creditorId: zid('entity2'),
				debtId: zid('entity3'),
				amountCents: z.number().int(),
				scheduledDate: z.string(),
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

/** The five operations of one domain; each declaration is built when its thunk runs. */
export function defineOperations(tables: ReturnType<typeof defineAppTables>) {
	const table = tables.entity1
	const id = () => zid('entity1')
	return {
		create: { kind: 'mutation', args: () => table.commandInput, returns: () => table.dto(true) },
		update: {
			kind: 'mutation',
			args: () => ({ id: id(), patch: table.updateSchema }),
			returns: () => z.null(),
		},
		get: { kind: 'query', args: () => ({ id: id() }), returns: () => table.publicDto.nullable() },
		list: {
			kind: 'query',
			args: () => ({
				status: z.enum(['open', 'closed', 'archived']).optional(),
				limit: z.number().optional(),
			}),
			returns: () => z.array(table.publicDto),
		},
		archive: { kind: 'mutation', args: () => ({ id: id() }), returns: () => z.null() },
	} satisfies Record<string, Operation>
}
