import type { IdempotencyVersions } from 'cvx-kit/idempotency'
import { v } from 'convex/values'
import { internalQuery } from './_generated/server'

// The deployment driver changes this server module in its isolated fixture copy.
// Callers cannot supply versions, and the retained receipt is never patched.
export const baseVersions: IdempotencyVersions = {
	operation: '1',
	contract: '1',
	binding: '1',
	fingerprintPolicy: 'raw-1',
}

export const deployedConfiguration = internalQuery({
	args: {},
	returns: v.object({
		operation: v.string(),
		contract: v.string(),
		binding: v.string(),
		fingerprintPolicy: v.string(),
	}),
	handler: () => baseVersions,
})
