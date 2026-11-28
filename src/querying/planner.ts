import { evaluateFilter } from './shared/evaluate'
import type { SchemaDefinition, GenericSchema } from 'convex/server'
import type { PropertyValidators, Value, VObject } from 'convex/values'
import type { KSchema, KType } from '../k'
import {
	getRelationExecutor,
	getRelationMetadata,
	type RelationRegistryIdentity,
} from '../relations'
import {
	parseFilterPlan,
	type FilterAst,
	type IndexCondition,
	type NativePagination,
} from './filters'
import type { FilterTree } from './shared/filters'

interface SelectionTree {
	[name: string]: true | SelectionTree
}
interface GroupTree {
	relations: Record<string, GroupTree>
}
/** What one cursor binding can depend on: a root, the path to its table and what it reads there. */
export interface RegistryScope {
	readonly root: string
	readonly path: readonly string[]
	readonly selection: SelectionTree
	readonly groups: GroupTree
	readonly filters: readonly FilterAst[]
}

/** The engine's pagination input: Convex's options, bounded, plus filters and order. */
export type QueryInput = NativePagination & { filters?: FilterTree; order?: 'asc' | 'desc' }
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
	const inputs = new Map<string, PaginationSchema>()
	// Digests per used scope; a scope is a few sorted names, so the cap only bounds abuse.
	const versions = new Map<string, Promise<string>>()
	/**
	 * The registry version a cursor binds: a digest of the identity of every table
	 * and edge the query can read. That is its table, the path edges to it, and
	 * every edge its selection, field groups and relation filters walk, with the
	 * tables those edges touch. Nothing else can change what such a cursor means.
	 */
	function registryVersion(scope: RegistryScope): Promise<string> {
		const tables = new Set([scope.root])
		const edges = new Map<string, readonly [string, string]>()
		function walk(table: string, name: string): string {
			const edge = metadata.declarations[table]?.[name]
			if (!edge) throw new Error('INVALID_RELATION')
			edges.set(JSON.stringify([table, name]), [table, name])
			return edge.target
		}
		function select(table: string, selection: SelectionTree): void {
			for (const [name, nested] of Object.entries(selection)) {
				const target = walk(table, name)
				if (nested !== true) select(target, nested)
			}
		}
		function group(table: string, groups: GroupTree): void {
			for (const [name, nested] of Object.entries(groups.relations))
				group(walk(table, name), nested)
		}
		function filter(table: string, ast: FilterAst): void {
			if (ast.kind === 'and' || ast.kind === 'or')
				for (const child of ast.children) filter(table, child)
			else if (ast.kind === 'not' || ast.kind === 'variant') filter(table, ast.child)
			else if (ast.kind === 'relation') {
				const target = walk(table, ast.name)
				if (ast.predicate) filter(target, ast.predicate)
			}
		}
		let table = scope.root
		for (const name of scope.path) table = walk(table, name)
		tables.add(table)
		select(table, scope.selection)
		group(table, scope.groups)
		for (const ast of scope.filters) filter(table, ast)
		const key = JSON.stringify([[...tables].sort(), [...edges.keys()].sort()])
		let version = versions.get(key)
		if (!version) {
			version = digest(owned.scopedIdentity([...tables], [...edges.values()]))
			if (versions.size >= 256) versions.clear()
			versions.set(key, version)
		}
		return version
	}
	return {
		metadata,
		select: owned.select,
		groups: owned.groups,
		validateDocument: owned.validateDocument,
		streamSchema: owned.streamSchema,
		registryVersion,
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
				validator = paginationSchema(owned.pagination(table))
				inputs.set(table, validator)
			}
			// Server constraints are independently validated against stored fields,
			// not the endpoint's public input/filter mask. Client values cannot replace them.
			const where: FilterTree =
				constraints.length === 1
					? constraints[0]
					: constraints.length
						? { and: [...constraints] }
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

/** The pagination boundary the planner parses with; its input and output are both `QueryInput`. */
type PaginationSchema = KSchema<QueryInput, VObject<QueryInput, PropertyValidators>>

export function scalarMatches(
	ast: FilterAst,
	document: Record<string, Value | undefined>,
): boolean {
	return evaluateFilter(ast, document) === true
}

/** Lowercase hex SHA-256 of the UTF-8 text. */
export async function digest(text: string): Promise<string> {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
		(byte) => byte.toString(16).padStart(2, '0'),
	).join('')
}

function paginationSchema(schema: KType): PaginationSchema {
	// SAFETY: the relation executor builds the engine pagination object, whose parse yields QueryInput.
	return schema as PaginationSchema
}
