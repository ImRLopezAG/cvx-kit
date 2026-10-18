import type { z } from 'zod'
import type { SchemaDefinition, GenericSchema } from 'convex/server'
import { compareValues, type Value } from 'convex/values'
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
		) {
			return owned.project(table, document, () => permitted && scalarMatches(residual, document))
		},
		plan(
			table: string,
			input: QueryInput,
			conditions: readonly IndexCondition[],
			constraints: readonly StoredConstraint[],
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
				metadata.tables[table].indexes,
				conditions,
				where,
			)
			if (compiled.residual.kind !== 'and') throw new Error('Invalid compiled filter root')
			const [client, server] = compiled.residual.children
			const empty: FilterAst = { kind: 'and', children: [] }
			const clientIdentity = { kind: 'and', children: [client, empty] }
			const serverIdentity = { kind: 'and', children: [server, empty] }
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

/** Native scalar ordering/equality, including missing vs null, without coercion. */
export function scalarMatches(
	ast: FilterAst,
	document: Record<string, Value | undefined>,
): boolean {
	switch (ast.kind) {
		case 'and':
			return ast.children.every((child) => scalarMatches(child, document))
		case 'or':
			return ast.children.some((child) => scalarMatches(child, document))
		case 'variant':
			return document[ast.discriminator] === ast.tag && scalarMatches(ast.child, document)
		case 'not':
			return !scalarMatches(ast.child, document)
		case 'relation':
			throw new Error('Relation execution requires U6')
		case 'scalar': {
			const actual = document[ast.field]
			if (ast.operator === 'exists') return (actual !== undefined) === ast.value
			if (ast.operator === 'in')
				return (
					Array.isArray(ast.value) && ast.value.some((value) => compareValues(actual, value) === 0)
				)
			if (Array.isArray(ast.value)) throw new Error('Invalid scalar predicate')
			const compared = compareValues(actual, ast.value)
			switch (ast.operator) {
				case 'eq':
					return compared === 0
				case 'gt':
					return compared > 0
				case 'gte':
					return compared >= 0
				case 'lt':
					return compared < 0
				case 'lte':
					return compared <= 0
			}
		}
	}
}
