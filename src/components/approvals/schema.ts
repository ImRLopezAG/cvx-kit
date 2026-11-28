import { defineSchema, defineTable } from 'convex/server'

import { APPROVAL_ACTOR_DECISION_INDEX, APPROVAL_DECISION_HISTORY_INDEX } from './constants'
import { approvalDecisionDocument, approvalRunDocument } from './validators'

export default defineSchema({
	approvalRuns: defineTable(approvalRunDocument.validator)
		.index('by_resourceType_and_resourceRef', ['resourceType', 'resourceRef'])
		.index('by_scopeRef_and_state', ['scopeRef', 'state'])
		.index('by_state_and_expiresAt', ['state', 'expiresAt']),
	approvalDecisions: defineTable(approvalDecisionDocument.validator)
		.index(APPROVAL_ACTOR_DECISION_INDEX, ['runId', 'stepKey', 'actor.actorRef'])
		.index('by_runId_and_stepKey_and_decidedAt', ['runId', 'stepKey', 'decidedAt'])
		.index(APPROVAL_DECISION_HISTORY_INDEX, ['runId', 'decidedAt']),
})
