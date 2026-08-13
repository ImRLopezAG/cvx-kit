import type { TransactionMetrics } from 'convex/server'

export type TransactionMetricsContext = Readonly<{
	meta: Readonly<{
		getTransactionMetrics: () => Promise<TransactionMetrics>
	}>
}>

export type Result<Value, Failure> =
	| Readonly<{ ok: true; value: Value }>
	| Readonly<{ ok: false; error: Failure }>

export type ResultBoundary<Failure> = Readonly<{
	ok: <Value>(value: Value) => Result<Value, Failure>
	handledError: <Value = never>(failure: Failure) => Result<Value, Failure>
	dataOf: (error: unknown) => Failure | undefined
}>

const metricNames = [
	'bytesRead',
	'bytesWritten',
	'databaseQueries',
	'documentsRead',
	'documentsWritten',
	'functionsScheduled',
	'scheduledFunctionArgsBytes',
] as const satisfies readonly (keyof TransactionMetrics)[]

const effectMetricNames = [
	'bytesWritten',
	'documentsWritten',
	'functionsScheduled',
	'scheduledFunctionArgsBytes',
] as const satisfies readonly (keyof TransactionMetrics)[]

/** Return handled failures only before effects; otherwise rethrow for rollback. */
export async function executeResultBoundary<Value, Failure>(
	ctx: TransactionMetricsContext,
	operation: () => Promise<Value>,
	boundary: ResultBoundary<Failure>,
): Promise<Result<Value, Failure>> {
	try {
		return boundary.ok(await operation())
	} catch (error) {
		const handled = boundary.dataOf(error)
		if (handled === undefined) throw error
		try {
			if (hasEffects(await ctx.meta.getTransactionMetrics())) throw error
		} catch {
			throw error
		}
		return boundary.handledError(handled)
	}
}

export function projectResult<Value, Failure>(
	result: Result<Value, Failure>,
	projectFailure: (failure: Failure) => never,
): Value {
	return result.ok ? result.value : projectFailure(result.error)
}

function hasEffects(metrics: TransactionMetrics): boolean {
	for (const name of metricNames) {
		const metric = metrics[name]
		if (
			!metric ||
			!Number.isFinite(metric.used) ||
			metric.used < 0 ||
			!Number.isFinite(metric.remaining) ||
			metric.remaining < 0
		) {
			throw new Error('Unreadable transaction metrics')
		}
	}
	return effectMetricNames.some((name) => metrics[name].used > 0)
}
