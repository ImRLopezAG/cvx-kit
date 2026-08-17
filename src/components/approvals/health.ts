import { v } from 'convex/values'

import { query } from './_generated/server'
import {
	APPROVAL_COMPONENT_SCHEMA_VERSION,
	APPROVAL_REQUIRED_DECISION_INDEXES,
} from './constants'

/**
 * Verifies that the package's component schema and required decision indexes
 * were deployed. A missing schema fails with a cvx-kit-specific diagnostic.
 */
export const check = query({
	args: {},
	returns: v.object({
		status: v.literal('ready'),
		schemaVersion: v.literal(APPROVAL_COMPONENT_SCHEMA_VERSION),
		requiredIndexes: v.array(v.string()),
	}),
	handler: async (ctx) => {
		try {
			for (const index of APPROVAL_REQUIRED_DECISION_INDEXES) {
				await ctx.db.query('approvalDecisions').withIndex(index).take(1)
			}
		} catch (error) {
			throw new Error(
				`cvx-kit approvals schema v${APPROVAL_COMPONENT_SCHEMA_VERSION} is not installed with its required indexes. Remove consumer patches, reinstall cvx-kit, and deploy again. Cause: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		return {
			status: 'ready' as const,
			schemaVersion: APPROVAL_COMPONENT_SCHEMA_VERSION,
			requiredIndexes: [...APPROVAL_REQUIRED_DECISION_INDEXES],
		}
	},
})
