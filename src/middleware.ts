import { defaultErrors, type ErrorFactory } from './errors'

/**
 * Structural surface of @convex-dev/rate-limiter's RateLimiter (checked
 * against 0.3.x; re-verify at install). The host mounts the component and
 * constructs the limiter; the kit only ever receives the instance —
 * injection keeps the kit dependency-free.
 */
export type RateLimiterLike = {
	limit: (
		ctx: never,
		name: string,
		options?: { key?: string },
	) => Promise<{ ok: boolean; retryAfter?: number }>
}

/**
 * The first packaged middleware: rate limiting on the Command/Query
 * middleware seams. Runs before guards and the handler; a rejected call
 * throws RATE_LIMITED (audit and handler never run). Keyed by ctx.tenant by
 * default — when no key fn is given and ctx.tenant is undefined, this is a
 * configuration error, not a silent shared bucket.
 *
 * The returned middleware is shape-compatible with both AnyCommandMiddleware
 * and AnyQueryMiddleware.
 */
export function rateLimit(config: {
	limiter: RateLimiterLike
	name: string
	/** Defaults to ctx.tenant. */
	key?: (context: never) => string
	/** Observe a rejection before the throw (metrics, headers). */
	onLimit?: (
		status: { ok: boolean; retryAfter?: number },
		context: never,
	) => void | Promise<void>
	errors?: ErrorFactory
}) {
	const errors = config.errors ?? defaultErrors
	return async (input: {
		context: never
		next: (options?: { context?: unknown }) => Promise<unknown>
	}): Promise<unknown> => {
		const key = config.key
			? config.key(input.context)
			: (input.context as { tenant?: string }).tenant
		if (key === undefined) {
			return errors.throw({
				code: 'RATE_LIMIT_KEY_MISSING',
				message: `rateLimit("${config.name}") has no key: ctx.tenant is undefined and no key fn was configured`,
			})
		}
		const status = await config.limiter.limit(input.context, config.name, {
			key,
		})
		if (!status.ok) {
			await config.onLimit?.(status, input.context)
			return errors.throw({
				code: 'RATE_LIMITED',
				message: `Rate limit "${config.name}" exceeded${
					status.retryAfter === undefined
						? ''
						: `; retry after ${Math.ceil(status.retryAfter)}ms`
				}`,
			})
		}
		return input.next()
	}
}
