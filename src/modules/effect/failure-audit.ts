import { Cause, Effect, Exit } from 'effect'
import type { Value } from 'convex/values'
import { isRecord, type ErrorContract, type ErrorDefinitions } from '../contracts/errors'
import { projectErrorCause } from './errors'
import { observationFailure } from './normalize'
import type { ScopeState } from './scope'

type JsonRecord = Readonly<Record<string, Value>>
type ProjectingContract = Pick<ErrorContract<ErrorDefinitions>, 'project'>

/** One failed operation, without raw input, unredacted details, defect messages or stacks. */
export type FailureAuditEntry = Readonly<{
	kind: 'command' | 'query' | 'action'
	operation: string
	classification: string
	/** The declared contract code, or `UNKNOWN_FAILURE` when no contract recognizes the failure. */
	errorCode: string
	declared: boolean
	/** The outermost operation of the request and this operation's nesting depth (0 for the root). */
	root: string
	depth: number
	/** Present only when the `details` redactor returned a plain JSON record. */
	details?: JsonRecord
	/** Present only when the `input` redactor returned a plain JSON record. */
	input?: JsonRecord
}>

/**
 * Host-free failure sink. A failed mutation rolls back every write it made, so failure
 * entries go to logs or log streams; inside queries and mutations `emit` has no `fetch`.
 */
export type FailureAuditOptions = Readonly<{
	emit: (entry: FailureAuditEntry) => void | PromiseLike<void>
	/** Projects failures that the operation's own registry contract does not recognize. */
	errors?: ProjectingContract
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Redactors receive validated declared details of any registered contract.
	details?: (details: unknown, errorCode: string, operation: string) => JsonRecord | undefined
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Redactors receive the operation's decoded input of any registered schema.
	input?: (input: unknown, operation: string) => JsonRecord | undefined
}>

type FailureReport = Readonly<{
	kind: FailureAuditEntry['kind']
	operation: string
	classification: string
	// oxlint-disable-next-line anti-slop/no-unknown-type-aliases -- The decoded input of the failed operation; only a redactor may read it.
	input: unknown
	contract?: ProjectingContract
	entered: ScopeState | undefined
	current: ScopeState
}>

/** Report a failed exit once per failure value in the request; never changes the original outcome. */
export function reportFailure(
	options: FailureAuditOptions | undefined,
	exit: Exit.Exit<unknown, unknown>,
	report: FailureReport,
): Effect.Effect<void> {
	if (!options || Exit.isSuccess(exit)) return Effect.void
	const cause = exit.cause
	if (!Cause.hasFails(cause) && !Cause.hasDies(cause)) return Effect.void
	return emitQuietly(options, () => {
		const failure = observationFailure(cause)
		if (failure instanceof Object) {
			if (report.current.reported.has(failure)) return undefined
			report.current.reported.add(failure)
		}
		let projected = report.contract
			? projectErrorCause(report.contract, cause)
			: ({ _tag: 'UnknownFailure', version: 1 } as const)
		if (projected._tag !== 'DeclaredFailure' && options.errors)
			projected = projectErrorCause(options.errors, cause)
		const declaredFailure = projected._tag === 'DeclaredFailure' ? projected : undefined
		const errorCode = declaredFailure?.code ?? 'UNKNOWN_FAILURE'
		const details =
			declaredFailure && options.details
				? redact(() => options.details!(declaredFailure.details, errorCode, report.operation))
				: undefined
		const input = options.input
			? redact(() => options.input!(report.input, report.operation))
			: undefined
		return Object.assign(
			{
				kind: report.kind,
				operation: report.operation,
				classification: report.classification,
				errorCode,
				declared: declaredFailure !== undefined,
				...position(report),
			},
			details === undefined ? undefined : { details },
			input === undefined ? undefined : { input },
		)
	})
}

export function reportAuditWriteFailure(
	options: FailureAuditOptions | undefined,
	report: Pick<FailureReport, 'operation' | 'classification' | 'entered'>,
): Effect.Effect<void> {
	// Without a sink, still leave a payload-free trace that an audited action went unrecorded.
	if (!options)
		return Effect.sync(() => {
			try {
				console.error(
					JSON.stringify({
						event: 'action.audit_write_failed',
						errorCode: 'ACTION_AUDIT_WRITE_FAILED',
						operation: report.operation,
						classification: report.classification,
					}),
				)
			} catch {
				// The fallback trace is as inert as the sink it replaces.
			}
		})
	return emitQuietly(options, () => ({
		kind: 'action',
		operation: report.operation,
		classification: report.classification,
		errorCode: 'ACTION_AUDIT_WRITE_FAILED',
		declared: false,
		...position(report),
	}))
}

/** The sink is inert: building or emitting an entry can never change the operation's outcome. */
function emitQuietly(
	options: FailureAuditOptions,
	build: () => FailureAuditEntry | undefined,
): Effect.Effect<void> {
	return Effect.tryPromise({
		try: async () => {
			const entry = build()
			if (entry) await options.emit(Object.freeze(entry))
		},
		catch: () => undefined,
	}).pipe(Effect.ignore)
}

function position(report: Pick<FailureReport, 'operation' | 'entered'>) {
	return {
		root: report.entered?.scope.root ?? report.operation,
		depth: report.entered?.scope.depth ?? 0,
	}
}

function redact(read: () => JsonRecord | undefined): JsonRecord | undefined {
	try {
		const value: unknown = read()
		// Application redactors are untrusted; only a plain record may enter the entry.
		if (!isRecord(value)) return undefined
		// SAFETY: the JSON round trip yields plain JSON values, a subset of Convex values.
		return JSON.parse(JSON.stringify(value)) as JsonRecord
	} catch {
		return undefined
	}
}
