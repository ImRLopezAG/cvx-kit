import type { GenericMutationCtx, GenericDataModel, FunctionReference } from 'convex/server'
import { z } from 'zod'
import { defaultErrors, type ErrorFactory } from './errors'
import { zodTable } from './zod-table'

/**
 * The host-owned dedup table (the kit gains no tables). Register it in the
 * schema with the by_eventKey index:
 *
 *   webhookEvents: webhookEventsTable().table.index('by_eventKey', ['eventKey'])
 *
 * Rows are host-owned data: prune them on a retention window comfortably
 * longer than the provider's redelivery horizon (a cleanup cron over
 * `receivedAt` — see docs/webhooks.md).
 */
export function webhookEventsTable() {
	return zodTable('webhookEvents', () => ({
		eventKey: z.string(),
		source: z.string(),
		receivedAt: z.number(),
	}))
}

type DedupContext = Pick<GenericMutationCtx<GenericDataModel>, 'db'>

/**
 * Transactional insert-if-absent dedup guard. Call this FIRST inside the
 * internal mutation the boundary delegates to — dedup must live in the
 * mutation (transactional), never in the action. Returns duplicate: true
 * when the natural key was already recorded; the caller then no-ops.
 */
export async function recordWebhookEvent(
	ctx: DedupContext,
	input: { key: string; source?: string; table?: string },
): Promise<{ duplicate: boolean }> {
	const table = input.table ?? 'webhookEvents'
	const existing = await ctx.db
		.query(table)
		.withIndex('by_eventKey', (builder) => builder.eq('eventKey', input.key))
		.first()
	if (existing) return { duplicate: true }
	await ctx.db.insert(table, {
		eventKey: input.key,
		source: input.source ?? 'unknown',
		receivedAt: Date.now(),
	})
	return { duplicate: false }
}

export type WebhookBoundaryConfig = {
	/**
	 * Verifies the provider signature over the RAW body bytes — the helper
	 * hands it `request.text()` BEFORE any parsing. Implementations must use
	 * a constant-time comparison (e.g. crypto.subtle HMAC verify) and read
	 * the secret from a Convex environment variable. Return false or throw
	 * to reject.
	 */
	verify: (raw: string, request: Request) => boolean | Promise<boolean>
	/**
	 * Derives the natural dedup key — the `${event}:${id}:${updatedAt}`
	 * pattern. Receives the raw body and the request; parse inside if needed.
	 */
	eventKey: (raw: string, request: Request) => string | Promise<string>
	source?: string
	errors?: ErrorFactory
}

/**
 * The sanctioned webhook pattern as code: verify (raw body, fail closed) →
 * derive natural key → delegate to a host internal mutation whose FIRST act
 * is recordWebhookEvent (transactional dedup). Use inside the host's
 * httpAction:
 *
 *   const boundary = createWebhookBoundary({ verify, eventKey })
 *   http.route({ path: '/webhooks/vendor', method: 'POST',
 *     handler: httpAction((ctx, request) =>
 *       boundary.handle(ctx, request, internal.domain.vendor.functions.applyEvent)) })
 */
export function createWebhookBoundary(config: WebhookBoundaryConfig) {
	const errors = config.errors ?? defaultErrors

	async function handle<Result>(
		ctx: {
			runMutation: (
				target: FunctionReference<'mutation', 'internal', WebhookDelivery, Result>,
				args: WebhookDelivery,
			) => Promise<Result>
		},
		request: Request,
		target: FunctionReference<'mutation', 'internal', WebhookDelivery, Result>,
	): Promise<Response> {
		const raw = await request.text()
		let verified = false
		try {
			verified = await config.verify(raw, request)
		} catch {
			verified = false
		}
		if (!verified) {
			errors.throw({
				code: 'WEBHOOK_SIGNATURE_INVALID',
				message: 'Webhook signature verification failed',
			})
		}
		const key = await config.eventKey(raw, request)
		await ctx.runMutation(target, {
			eventKey: key,
			payload: raw,
			source: config.source ?? 'unknown',
		})
		return new Response(null, { status: 200 })
	}

	return { handle }
}

export type WebhookDelivery = { eventKey: string; payload: string; source: string }
