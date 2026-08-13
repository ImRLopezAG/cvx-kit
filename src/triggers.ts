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
 * Maintains a server-owned `updatedAt` field on every insert and update.
 * Pair with zod-table's timestampFields + serverFields mask.
 */
export function touchUpdatedAt<DataModel extends GenericDataModel>(
	triggers: Triggers<DataModel>,
	...tables: readonly TableNamesInDataModel<DataModel>[]
) {
	for (const table of tables) {
		triggers.register(table, async (ctx, change) => {
			if (change.operation === 'delete') return
			const document = change.newDoc as { updatedAt?: number }
			// Only touch when the write didn't already set it, to avoid loops.
			if (document.updatedAt === undefined) {
				await ctx.innerDb.patch(change.id, {
					updatedAt: Date.now(),
				} as never)
			}
		})
	}
}
