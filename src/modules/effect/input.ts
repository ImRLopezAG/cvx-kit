/* oxlint-disable anti-slop/no-unknown-parameters -- Input decoding and cause inspection receive untrusted values. */
import { Cause, Effect, Schema } from 'effect'
import type { SchemaIssue } from 'effect'
import { $ZodError } from 'zod/v4/core'
import type { ContractOutput, ContractSchema } from '../contracts/contract'
import {
	ARGUMENT_ISSUE_LIMITS,
	argumentErrors,
	sanitizeArgumentIssues,
	type ArgumentFailurePolicy,
} from '../contracts/errors'
import { markArgumentRejection } from './errors'
import { reportFailure, type FailureAuditEntry, type FailureAuditOptions } from './failure-audit'
import { observationFailure } from './normalize'
import {
	ContractValidationError,
	decodeEffectContract,
	type ContractDecoderError,
	type ContractDecoderRequirements,
} from './schema'
import { enterRequestScope } from './scope'

type InputReport = Pick<FailureAuditEntry, 'kind' | 'operation' | 'classification'>

/** Only recognized input validation failures participate in the argument policy. */
export function decodeOperationInput<S extends ContractSchema>(
	schema: S,
	input: unknown,
	policy: ArgumentFailurePolicy | undefined,
	audit: FailureAuditOptions | undefined,
	report: InputReport,
): Effect.Effect<ContractOutput<S>, ContractDecoderError<S>, ContractDecoderRequirements<S>> {
	const decode = decodeEffectContract(schema, input)
	const legacy = policy === undefined || policy === 'legacy'
	if (legacy && !audit) return decode
	return decode.pipe(
		Effect.catchCause((cause) => {
			if (cause.reasons.length !== 1 || Cause.hasInterrupts(cause)) return Effect.failCause(cause)
			const failure = observationFailure(cause)
			if (
				!(failure instanceof $ZodError) &&
				!(failure instanceof ContractValidationError) &&
				!Schema.isSchemaError(failure)
			)
				return Effect.failCause(cause)

			const rejected = legacy
				? Effect.failCause(cause)
				: Effect.failCauseSync(() => {
						const issues = sanitizeArgumentIssues(validationIssues(failure))
						if (policy === 'declared') {
							return markArgumentRejection(
								Cause.die(argumentErrors.toConvexError('INVALID_ARGUMENTS', { issues })),
								true,
							)
						}
						try {
							return markArgumentRejection(
								Cause.die(policy(Object.freeze({ source: 'arguments', issues }))),
								false,
							)
						} catch (thrown) {
							return markArgumentRejection(Cause.die(thrown), false)
						}
					})
			if (!audit) return rejected
			return enterRequestScope(report.operation, false, (entered, current) =>
				rejected.pipe(
					Effect.onExit((exit) =>
						reportFailure(audit, exit, {
							...report,
							input: undefined,
							inputRejected: true,
							entered,
							current,
						}),
					),
				),
			)
		}),
	)
}

function validationIssues(failure: $ZodError | ContractValidationError | Schema.SchemaError) {
	if (failure instanceof $ZodError) return failure.issues
	if (failure instanceof ContractValidationError)
		return failure.issues.slice(0, ARGUMENT_ISSUE_LIMITS.issues).map((issue) => ({
			path: issue.path
				?.slice(0, ARGUMENT_ISSUE_LIMITS.pathSegments)
				// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Standard Schema paths allow either property keys or key wrappers.
				.map((segment) => (typeof segment === 'object' ? segment.key : segment)),
			code: 'code' in issue ? issue.code : undefined,
			message: issue.message,
		}))
	return nativeSchemaIssues(failure.issue)
}

/** Effect's default issue formatter interpolates rejected values into its messages. */
function nativeSchemaIssues(root: SchemaIssue.Issue) {
	const issues: { path: readonly PropertyKey[]; code: string; message: string }[] = []
	const limits = ARGUMENT_ISSUE_LIMITS
	function visit(issue: SchemaIssue.Issue, path: readonly PropertyKey[]) {
		switch (issue._tag) {
			case 'Pointer':
				visit(issue.issue, [...path, ...issue.path.slice(0, limits.pathSegments - path.length)])
				return
			case 'Encoding':
			case 'Filter':
				visit(issue.issue, path)
				return
			case 'Composite':
			case 'AnyOf':
				if (issue.issues.length > 0) {
					for (const child of issue.issues) {
						visit(child, path)
						if (issues.length >= limits.issues) break
					}
					return
				}
				break
		}
		issues.push({ path, code: issue._tag, message: 'Invalid value' })
	}
	visit(root, [])
	return issues
}
