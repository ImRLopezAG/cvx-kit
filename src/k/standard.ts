import type { StandardSchemaV1 } from '@standard-schema/spec'
import { safeParseSchema } from './parse'
import type { KNode } from './types'

/**
 * The Standard Schema v1 props of a schema, built when `~standard` is read; nothing is stored on the
 * schema. `validate` delegates to the same walker as `safeParse`.
 */
export function standardProps<In, Out>(schema: KNode): StandardSchemaV1.Props<In, Out> {
	return {
		version: 1,
		vendor: 'cvx-kit',
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Standard Schema validates undecoded input.
		validate: (value: unknown) => standardResult<Out>(schema, value),
	}
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Standard Schema validates undecoded input.
function standardResult<Out>(schema: KNode, value: unknown): StandardSchemaV1.Result<Out> {
	const result = safeParseSchema(schema, value)
	if (result.success) {
		// SAFETY: a successful walk of the schema produces its declared output.
		return { value: result.data as Out }
	}
	return { issues: result.issues.map(standardIssue) }
}

function standardIssue(issue: {
	readonly message: string
	readonly path: readonly (string | number)[]
}): StandardSchemaV1.Issue {
	return { message: issue.message, path: issue.path }
}
