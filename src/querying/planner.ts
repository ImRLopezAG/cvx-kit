import { evaluateFilter } from './shared/evaluate'
import type { z } from 'zod'
import type { SchemaDefinition, GenericSchema } from 'convex/server'
import { type Value } from 'convex/values'
import {
	getRelationExecutor,
	getRelationMetadata,
	type RelationRegistryIdentity,
} from '../relations'
import { parseFilterPlan, type FilterAst, type IndexCondition } from './filters'

export type QueryInput = z.input<ReturnType<ReturnType<typeof getRelationExecutor>['pagination']>>
export type StoredConstraint = NonNullable<QueryInput['filters']>

export function createPlanner(
	schema: SchemaDefinition<GenericSchema, boolean>,
	relations: RelationRegistryIdentity,
) {
	const owned = getRelationExecutor(relations)
	owned.assertSchema(schema.tables)
	const metadata = getRelationMetadata(relations)
	// Build each immutable filter grammar only when that table is queried. Engine
	// declarations also load in mutations, which never need pagination validators.
	const inputs = new Map<string, ReturnType<typeof owned.pagination>>()
	return {
		metadata,
		select: owned.select,
		groups: owned.groups,
		validateDocument: owned.validateDocument,
		streamSchema: owned.streamSchema,
		beforeLeaf(table: string) {
			if (!Object.hasOwn(metadata.tables, table)) throw new Error('Unknown query table')
		},
		complete(
			table: string,
			document: Record<string, Value>,
			permitted: boolean,
			residual: FilterAst,
			groups: readonly string[] = [],
		) {
			return owned.project(
				table,
				document,
				() => permitted && scalarMatches(residual, document),
				groups,
			)
		},
		plan(
			table: string,
			input: QueryInput,
			conditions: readonly IndexCondition[],
			constraints: readonly StoredConstraint[],
			ordering?: string,
			traversal: 'root' | 'relation' = 'root',
		) {
			if (!Object.hasOwn(metadata.tables, table)) throw new Error('Unknown query table')
			let validator = inputs.get(table)
			if (!validator) {
				validator = owned.pagination(table)
				inputs.set(table, validator)
			}
			// Server constraints are independently validated against stored fields,
			// not the endpoint's public input/filter mask. Client values cannot replace them.
			const where =
				constraints.length === 1
					? constraints[0]
					: constraints.length
						? { and: constraints }
						: undefined
			const { args, compiled } = parseFilterPlan(
				validator,
				input,
				traversal === 'relation' && ordering === undefined ? [] : metadata.tables[table].indexes,
				conditions,
				where,
				ordering,
			)
			if (compiled.residual.kind !== 'and') throw new Error('Invalid compiled filter root')
			const [client, server] = compiled.residual.children
			const empty: FilterAst = { kind: 'and', children: [] }
			const clientIdentity = { kind: 'and', children: [client, empty] }
			const serverIdentity = compiled.sets.size
				? {
						kind: 'and',
						children: [server, empty],
						traversal: { version: 2, expansion: compiled.expansion },
					}
				: { kind: 'and', children: [server, empty] }
			// SAFETY: normalized AST nodes contain only validated native scalar Values.
			return {
				...compiled,
				args,
				clientIdentity: clientIdentity as Value,
				serverIdentity: serverIdentity as Value,
			}
		},
	}
}

export function scalarMatches(
	ast: FilterAst,
	document: Record<string, Value | undefined>,
): boolean {
	return evaluateFilter(ast, document) === true
}
