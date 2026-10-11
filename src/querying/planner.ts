import type { z } from 'zod'
import type { SchemaDefinition, GenericSchema } from 'convex/server'
import { compareValues, type Value } from 'convex/values'
import {
	getRelationExecutor,
	getRelationMetadata,
	type RelationRegistryIdentity,
} from '../relations'
import { compileFilters, type FilterAst, type IndexCondition } from './filters'

export type QueryInput = z.input<ReturnType<ReturnType<typeof getRelationExecutor>['pagination']>>
export type StoredConstraint = NonNullable<QueryInput['filters']>

export function createPlanner(
	schema: SchemaDefinition<GenericSchema, boolean>,
	relations: RelationRegistryIdentity,
) {
	const owned = getRelationExecutor(relations)
	const assertUnchanged = () => owned.assertSchema(schema.tables)
	assertUnchanged()
	const metadata = getRelationMetadata(relations)
	const inputs = new Map(
		Object.keys(metadata.tables).map((table) => [table, owned.pagination(table)]),
	)
	return {
		metadata,
		page: owned.page,
		assertUnchanged,
		beforeLeaf(table: string) {
			owned.assertNativeTable(table, schema.tables[table])
		},
		complete(
			table: string,
			document: Record<string, Value>,
			permitted: boolean,
			residual: FilterAst,
		) {
			return owned.project(
				schema.tables,
				table,
				document,
				() => permitted && scalarMatches(residual, document),
			)
		},
		plan(
			table: string,
			input: QueryInput,
			conditions: readonly IndexCondition[],
			constraints: readonly StoredConstraint[],
		) {
			assertUnchanged()
			const validator = inputs.get(table)
			if (!validator) throw new Error('Unknown query table')
			const args = validator.parse(input)
			// Server constraints are independently validated against stored fields,
			// not the endpoint's public input/filter mask. Client values cannot replace them.
			const where =
				constraints.length === 1
					? constraints[0]
					: constraints.length
						? { and: constraints }
						: undefined
			const compiled = compileFilters(
				validator,
				args,
				metadata.tables[table].indexes,
				conditions,
				where,
			)
			const client = compileFilters(validator, args, []).residual
			const server = compileFilters(validator, { ...args, filters: where }, []).residual
			// SAFETY: normalized AST nodes contain only validated native scalar Values.
			return { ...compiled, args, clientIdentity: client as Value, serverIdentity: server as Value }
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
