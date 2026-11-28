import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'
import { safeParseSchema } from './parse'
import type { KNode } from './types'

/** Builds the Standard JSON Schema converter of a schema; installed by importing `cvx-kit/json-schema`. */
export type KJsonSchemaInstaller = (schema: KNode) => StandardJSONSchemaV1.Converter

let jsonSchemaConverter: KJsonSchemaInstaller | undefined

/**
 * The Standard Schema v1 props of a schema, built when `~standard` is read; nothing is stored on the
 * schema. `validate` delegates to the same walker as `safeParse`. Once `cvx-kit/json-schema` is
 * imported the props also carry Standard JSON Schema's `jsonSchema` converter; without it the
 * property is absent, so the converter never reaches a bundle that does not import that entry.
 */
export function standardProps<In, Out>(
	schema: KNode,
): StandardSchemaV1.Props<In, Out> & { readonly jsonSchema?: StandardJSONSchemaV1.Converter } {
	const props = {
		version: 1 as const,
		vendor: 'cvx-kit',
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Standard Schema validates undecoded input.
		validate: (value: unknown) => standardResult<Out>(schema, value),
	}
	if (jsonSchemaConverter === undefined) return props
	return { ...props, jsonSchema: jsonSchemaConverter(schema) }
}

/** Called once by `cvx-kit/json-schema` at import. */
export function installJsonSchemaConverter(install: KJsonSchemaInstaller): void {
	jsonSchemaConverter = install
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
