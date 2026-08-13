import {
	Triggers,
	type Change,
	type Trigger,
} from 'convex-helpers/server/triggers'
import type {
	GenericDataModel,
	TableNamesInDataModel,
} from 'convex/server'

export { Triggers }
export type { Change, Trigger }

/**
 * One application-wide mutation interceptor registry. Pass it to
 * createAuthFunctions({ triggers }) so every authMutation/roleMutation/
 * systemMutation runs writes through it — trigger enforcement becomes
 * structural, not a convention.
 */
export function createTriggers<
	DataModel extends GenericDataModel,
>(): Triggers<DataModel> {
	return new Triggers<DataModel>()
}

/**
 * Marks tables as append-only evidence tables: inserts pass, every update or
 * delete throws. The ontology pattern for votes/history/audit-style tables.
 */
export function appendOnly<DataModel extends GenericDataModel>(
	triggers: Triggers<DataModel>,
	...tables: readonly TableNamesInDataModel<DataModel>[]
) {
	for (const table of tables) {
		triggers.register(table, async (_ctx, change) => {
			if (change.operation !== 'insert') {
				throw new Error(`${table} is append-only`)
			}
		})
	}
}

/** Forbids hard deletes on the given tables (soft-delete discipline). */
export function noDelete<DataModel extends GenericDataModel>(
	triggers: Triggers<DataModel>,
	...tables: readonly TableNamesInDataModel<DataModel>[]
) {
	for (const table of tables) {
		triggers.register(table, async (_ctx, change) => {
			if (change.operation === 'delete') {
				throw new Error(`${table} rows cannot be deleted`)
			}
		})
	}
}

/**
 * Maintains zod-table's opinionated lifecycle timestamps: createdAt and
 * updatedAt on insert, updatedAt on every update. archivedAt stays under
 * application control. Register once per table; writes made through the
 * auth constructors keep these fields correct automatically.
 */
export function timestamps<DataModel extends GenericDataModel>(
	triggers: Triggers<DataModel>,
	...tables: readonly TableNamesInDataModel<DataModel>[]
) {
	for (const table of tables) {
		triggers.register(table, async (ctx, change) => {
			if (change.operation === 'delete') return
			const now = Date.now()
			if (change.operation === 'insert') {
				const document = change.newDoc as { createdAt?: number }
				if (document.createdAt === undefined) {
					await ctx.innerDb.patch(change.id, {
						createdAt: now,
						updatedAt: now,
					} as never)
				}
				return
			}
			const previous = change.oldDoc as { updatedAt?: number }
			const current = change.newDoc as { updatedAt?: number }
			// A write that already moved updatedAt (including our own patch)
			// is left alone — this is the recursion guard.
			if (current.updatedAt === previous.updatedAt) {
				await ctx.innerDb.patch(change.id, { updatedAt: now } as never)
			}
		})
	}
}
