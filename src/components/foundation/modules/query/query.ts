export type QueryExecution<Context, Metadata, Result> = Readonly<{
	context: Context
	metadata: Metadata
	run: () => Promise<Result>
}>

type MaybePromise<Value> = Value | Promise<Value>

/**
 * Composable, next()-based middleware around every query handler. Runs
 * inside the host's injected execute policy: `next({ context })` merges
 * enrichment into the context handed to inner middleware and the handler.
 */
export type QueryMiddleware<Context = never, Extension extends object = object> = <Result>(input: {
	metadata: object
	context: Context
	next: (options?: { context?: Extension }) => Promise<Result>
}) => Promise<Result>

/** Any-context middleware — what kernels and executors accept. */
// Contravariant seam: the supertype every typed QueryMiddleware<C, E>
// assigns to. The result stays generic across the chain; context is erased
// only in storage. Definition sites stay typed via Query.middleware.
export type AnyQueryMiddleware = <Result>(input: {
	metadata: object
	context: never
	next: (options?: { context?: object }) => Promise<Result>
}) => Promise<Result>

class QueryMiddlewareError extends Error {
	readonly code = 'QUERY_MIDDLEWARE_NEXT_REUSED'
	readonly name = 'QueryMiddlewareError'

	constructor() {
		super('A query middleware called next() more than once')
	}
}

/** Generic query kernel. Authorization remains an injected host policy. */
export class Query<Context, Defaults extends object> {
	readonly #defaults: Defaults
	readonly #middleware: readonly AnyQueryMiddleware[]
	readonly #execute: <Metadata extends object, Result>(
		execution: QueryExecution<Context, Defaults & Metadata, Result>,
	) => Promise<Result>

	/**
	 * Identity helper that types a middleware against its context and the
	 * extension it passes downstream via next({ context }).
	 */
	static middleware<Context = never, const Extension extends object = object>(
		middleware: QueryMiddleware<Context, Extension>,
	): QueryMiddleware<Context, Extension> {
		return middleware
	}

	constructor(configuration: {
		readonly defaults: Defaults
		readonly middleware?: readonly AnyQueryMiddleware[]
		readonly execute: <Metadata extends object, Result>(
			execution: QueryExecution<Context, Defaults & Metadata, Result>,
		) => Promise<Result>
	}) {
		this.#defaults = configuration.defaults
		this.#middleware = configuration.middleware ?? []
		this.#execute = configuration.execute
	}

	exec<Arguments extends readonly unknown[], Result, Metadata extends object = object>(executor: {
		readonly metadata?: Metadata
		readonly middleware?: readonly AnyQueryMiddleware[]
		readonly handler: (context: Context, ...args: Arguments) => MaybePromise<Result>
	}): (context: Context, ...args: Arguments) => Promise<Result> {
		return (context, ...args) => {
			const metadata = {
				...this.#defaults,
				...executor.metadata,
			}
			const middleware = [...this.#middleware, ...(executor.middleware ?? [])]
			const run = async (): Promise<Result> => {
				if (middleware.length === 0) {
					return executor.handler(context, ...args)
				}
				let deepest = -1
				const dispatch = async (index: number, current: Context): Promise<Result> => {
					if (index <= deepest) throw new QueryMiddlewareError()
					deepest = index
					const layer = middleware[index]
					if (!layer) return executor.handler(current, ...args)
					return layer({
						metadata,
						// SAFETY: middleware context is erased only in storage; the kernel supplies its Context.
						context: current as never,
						next: (options) =>
							dispatch(index + 1, options?.context ? { ...current, ...options.context } : current),
					})
				}
				return dispatch(0, context)
			}
			return this.#execute({ context, metadata, run })
		}
	}
}
