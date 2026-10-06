import type { AuditEntryInput } from '../../client'

/** Internal sequencing only: interpreters own callback normalization and observation. */
export interface ExecutionKind {
	readonly value: unknown
	readonly type: unknown
}
export type ExecutionValue<Kind extends ExecutionKind, Value> = (Kind & {
	readonly value: Value
})['type']
export interface LifecycleAlgebra<Kind extends ExecutionKind> {
	succeed<Value>(value: Value): ExecutionValue<Kind, Value>
	suspend<Value>(execute: () => ExecutionValue<Kind, Value>): ExecutionValue<Kind, Value>
	flatMap<Input, Output>(
		execution: ExecutionValue<Kind, Input>,
		next: (input: Input) => ExecutionValue<Kind, Output>,
	): ExecutionValue<Kind, Output>
}
export interface PromiseExecution extends ExecutionKind {
	readonly type: Promise<this['value']>
}
export const promiseLifecycle: LifecycleAlgebra<PromiseExecution> = {
	succeed: (value) => Promise.resolve(value),
	suspend: (execute) => Promise.resolve().then(execute),
	flatMap: (execution, next) => execution.then(next),
}
export type LifecyclePreparation<Kind extends ExecutionKind, Result> =
	| { kind: 'replay'; result: unknown }
	| { kind: 'execute'; complete?: (result: Result) => ExecutionValue<Kind, void> }
export type LifecycleMiddleware<Kind extends ExecutionKind, Context, Input, Raw> = (input: {
	operation: string
	context: Context
	command: Input
	next: (options?: { context?: object }) => ExecutionValue<Kind, Raw>
}) => ExecutionValue<Kind, Raw>
export type LifecycleExecution<Kind extends ExecutionKind, Context, Input, Raw, Result> = {
	operation: string
	classification: string
	context: Context
	command: Input
	permission?: () => ExecutionValue<Kind, void>
	prepare: () => ExecutionValue<Kind, LifecyclePreparation<Kind, Result> | undefined>
	parseReplay: <Value>(value: Value) => Result
	middleware: readonly LifecycleMiddleware<Kind, Context, Input, Raw>[]
	defaultGuard: (context: Context) => ExecutionValue<Kind, void>
	guard: (context: Context) => ExecutionValue<Kind, void>
	run: (context: Context) => ExecutionValue<Kind, Raw>
	parseResult: (value: Raw) => Result
	audit: (result: Result) => ExecutionValue<Kind, Omit<AuditEntryInput, 'classification'> | null>
	aggregates?: readonly string[]
	writeAudit: (entry: AuditEntryInput) => ExecutionValue<Kind, unknown>
}

/** One owner for the command protocol; every interpretation allocates fresh dispatch state. */
export function executeCommandLifecycle<Kind extends ExecutionKind, Context, Input, Raw, Result>(
	algebra: LifecycleAlgebra<Kind>,
	execution: LifecycleExecution<Kind, Context, Input, Raw, Result>,
): ExecutionValue<Kind, Result> {
	return algebra.suspend(() => {
		let deepest = -1
		const terminal = (context: Context): ExecutionValue<Kind, Raw> =>
			algebra.flatMap(execution.defaultGuard(context), () =>
				algebra.flatMap(execution.guard(context), () => execution.run(context)),
			)
		const dispatch = (index: number, context: Context): ExecutionValue<Kind, Raw> =>
			algebra.suspend(() => {
				if (index <= deepest) throw new CommandMiddlewareError(execution.operation)
				deepest = index
				const layer = execution.middleware[index]
				if (!layer) return terminal(context)
				return layer({
					operation: execution.operation,
					command: execution.command,
					context,
					next: (options) =>
						dispatch(index + 1, options?.context ? { ...context, ...options.context } : context),
				})
			})
		return algebra.flatMap(execution.permission?.() ?? algebra.succeed(undefined), () =>
			algebra.flatMap(execution.prepare(), (preparation) => {
				if (preparation?.kind === 'replay') {
					return algebra.suspend(() => algebra.succeed(execution.parseReplay(preparation.result)))
				}
				return algebra.flatMap(dispatch(0, execution.context), (raw) => {
					const result = execution.parseResult(raw)
					return algebra.flatMap(execution.audit(result), (audit) => {
						if (
							audit &&
							execution.aggregates &&
							!execution.aggregates.includes(audit.aggregate.type)
						) {
							throw new CommandAggregateError(execution.operation, audit.aggregate.type)
						}
						return algebra.flatMap(
							audit
								? execution.writeAudit({ ...audit, classification: execution.classification })
								: algebra.succeed(undefined),
							() =>
								algebra.flatMap(preparation?.complete?.(result) ?? algebra.succeed(undefined), () =>
									algebra.succeed(result),
								),
						)
					})
				})
			}),
		)
	})
}

export class CommandMiddlewareError extends Error {
	readonly code = 'COMMAND_MIDDLEWARE_NEXT_REUSED'
	readonly name = 'CommandMiddlewareError'
	constructor(operation: string) {
		super(`A middleware for operation "${operation}" called next() more than once`)
	}
}
export class CommandAggregateError extends Error {
	readonly code = 'COMMAND_AGGREGATE_NOT_DECLARED'
	readonly name = 'CommandAggregateError'
	constructor(operation: string, aggregateType: string) {
		super(
			`Operation "${operation}" audited aggregate type "${aggregateType}" outside its declared aggregates`,
		)
	}
}
export class CommandPermissionError extends Error {
	readonly code = 'COMMAND_PERMISSION_NOT_CONFIGURED'
	readonly name = 'CommandPermissionError'
	constructor(operation: string) {
		super(
			`Operation "${operation}" declares a permission but the Foundation has no checkPermission`,
		)
	}
}
