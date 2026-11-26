/* oxlint-disable anti-slop/no-unknown-parameters -- Input decoding and cause inspection receive untrusted values. */
import { Cause, Effect } from 'effect'
import type { Schema, SchemaIssue } from 'effect'
import { KValidationError } from '../../k/issues'
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
	const standard = policy === undefined || policy === 'validation'
	return decode.pipe(
		Effect.catchCause((cause) => {
			if (cause.reasons.length !== 1 || Cause.hasInterrupts(cause)) return Effect.failCause(cause)
			const failure = observationFailure(cause)
			if (
				!(failure instanceof KValidationError) &&
				!(failure instanceof ContractValidationError) &&
				!isSchemaError(failure)
			)
				return Effect.failCause(cause)

			const rejected = standard
				? // A `k` input already failed with the kit's VALIDATION error. Marking it lets the API
					// adapter throw it as is, where an error projection would reduce it to UnknownFailure.
					failure instanceof KValidationError
						? Effect.failCause(markArgumentRejection(Cause.die(failure), false))
						: Effect.failCause(cause)
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

/**
 * Effect's own `Schema.isSchemaError` check, done locally: importing `Schema` as a value would keep
 * `effect/Schema` (about 220 KB with `SchemaAST`) in every command and query bundle.
 */
const SCHEMA_ERROR_TYPE_ID = '~effect/Schema/SchemaError'
function isSchemaError(value: unknown): value is Schema.SchemaError {
	// SchemaError is a class instance; a primitive or a plain value without the stamp is not one.
	if (!(value instanceof Object) || !(SCHEMA_ERROR_TYPE_ID in value)) return false
	const stamped: { readonly [SCHEMA_ERROR_TYPE_ID]?: unknown } = value
	return stamped[SCHEMA_ERROR_TYPE_ID] === SCHEMA_ERROR_TYPE_ID
}

function validationIssues(
	failure: KValidationError | ContractValidationError | Schema.SchemaError,
) {
	if (failure instanceof KValidationError) return failure.data.issues
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
