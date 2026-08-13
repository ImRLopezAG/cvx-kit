export type QueryExecution<Context, Metadata, Result> = Readonly<{
	context: Context
	metadata: Metadata
	run: () => Promise<Result>
}>

type MaybePromise<Value> = Value | Promise<Value>

/** Generic query kernel. Authorization remains an injected host policy. */
export class Query<Context, Defaults extends object> {
	readonly #defaults: Defaults
	readonly #execute: <Metadata extends object, Result>(
		execution: QueryExecution<Context, Defaults & Metadata, Result>,
	) => Promise<Result>

	constructor(configuration: {
		readonly defaults: Defaults
		readonly execute: <Metadata extends object, Result>(
			execution: QueryExecution<Context, Defaults & Metadata, Result>,
		) => Promise<Result>
	}) {
		this.#defaults = configuration.defaults
		this.#execute = configuration.execute
	}

	exec<
		Arguments extends readonly unknown[],
		Result,
		Metadata extends object = object,
	>(executor: {
		readonly metadata?: Metadata
		readonly handler: (
			context: Context,
			...args: Arguments
		) => MaybePromise<Result>
	}): (context: Context, ...args: Arguments) => Promise<Result> {
		return (context, ...args) =>
			this.#execute({
				context,
				metadata: {
					...this.#defaults,
					...(executor.metadata ?? ({} as Metadata)),
				},
				run: async () => executor.handler(context, ...args),
			})
	}
}
