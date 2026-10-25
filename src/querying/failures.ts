import { queryErrors } from '../modules/contracts/errors'
import { CursorError } from './cursors'
import { FieldGroupError } from '../querying'
import { isQueryFanoutError } from './filters'

/**
 * Explicit endpoint adapter for the query.errors policy in createEffectAuthFunctions.
 * Promise handlers must use Effect.tryPromise({ try: () => engine(ctx).table.paginate(args), catch: error => error })
 * so native failures enter the expected-error channel; ordinary throws/rejections remain defects.
 * Ordinary authQuery handlers can throw new ConvexError(queryFailureContract.project(error)) in their catch.
 * Do not throw an already-transported ConvexError inside an Effect builder with a different errors policy:
 * that policy intentionally normalizes foreign failures. Direct engine callers keep their native errors.
 */
export const queryFailureContract: typeof queryErrors = {
	...queryErrors,
	project(error) {
		try {
			if (error instanceof CursorError)
				return queryErrors.project(queryErrors.create('invalid-cursor', {}))
			if (error instanceof FieldGroupError)
				return queryErrors.project(queryErrors.create('FIELD_GROUP_DENIED', {}))
			if (isQueryFanoutError(error))
				return queryErrors.project(queryErrors.create('QUERY_FANOUT', {}))
			return queryErrors.project(error)
		} catch {
			return { _tag: 'UnknownFailure', version: 1 }
		}
	},
}
