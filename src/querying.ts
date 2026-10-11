import type {
	GenericSchema,
	SchemaDefinition,
	DataModelFromSchemaDefinition,
	PaginationResult,
} from 'convex/server'
import type { GenericId } from 'convex/values'
import type {
	RelationTables,
	RelationDeclarations,
	RelationRegistry,
	RelationRow,
	RelationSelection,
	RelationFilters,
	RelationFilterSelection,
} from './relations'
import { createPlanner, type QueryInput, type StoredConstraint } from './querying/planner'
import { executeQuery, type ExecutionRequest } from './querying/execution'
import {
	relationshipExecutor,
	assertRelationshipDepth,
	type OutputSelection,
	type RelationDocument,
} from './querying/relationships'
import { createCursorCodec, type CursorCodecConfig, type CursorBinding } from './querying/cursors'
import {
	createManagedSecurity,
	type ManagedSecurityConfig,
	type ManagedQueryContext,
	type ManagedBudgets,
} from './querying/security'
import type { IndexCondition, NativePagination } from './querying/filters'

type FullMask<S> = {
	[K in keyof S]-?: NonNullable<S[K]> extends true ? true : FullMask<NonNullable<S[K]>>
}
type Paths<
	D extends RelationDeclarations,
	T extends string,
	L extends readonly 1[] = [1, 1, 1, 1],
> = L extends readonly [1, ...infer Rest extends 1[]]
	? {
			[K in keyof D[T] & string]:
				| (D[T][K]['cardinality'] extends 'many' ? K : never)
				| `${K}.${Paths<D, D[T][K]['target'], Rest>}`
		}[keyof D[T] & string]
	: never
type PathTarget<
	D extends RelationDeclarations,
	T extends string,
	P extends string,
> = P extends `${infer Head}.${infer Rest}`
	? PathTarget<D, D[T][Head]['target'], Rest>
	: D[T][P]['target']
type RemainingDepth<P extends string, L extends readonly 1[]> = L extends readonly [
	1,
	...infer Rest extends 1[],
]
	? P extends `${string}.${infer Tail}`
		? RemainingDepth<Tail, Rest>
		: Rest
	: []
type EngineArgs<
	Tables extends RelationTables,
	D extends RelationDeclarations,
	T extends keyof Tables,
> = NativePagination & {
	filters?: RelationFilters<Tables, D, T, FullMask<RelationFilterSelection<Tables, D, T>>>
	order?: 'asc' | 'desc'
}
interface TableQuery<
	Tables extends RelationTables,
	D extends RelationDeclarations,
	T extends keyof Tables,
	S = {},
	L extends readonly 1[] = [1, 1, 1, 1],
> {
	when(value: IndexCondition['value'], index: string): TableQuery<Tables, D, T, S, L>
	where(spec: NonNullable<EngineArgs<Tables, D, T>['filters']>): TableQuery<Tables, D, T, S, L>
	with<const Selection extends RelationSelection<Tables, D, T, L>>(
		selection: Selection & {
			[K in keyof Selection]: K extends keyof RelationSelection<Tables, D, T, L>
				? Selection[K]
				: never
		},
	): TableQuery<Tables, D, T, Selection, L>
	relation<const P extends Paths<D, Extract<T, string>>>(
		parent: GenericId<Tables[T]['tableName']>,
		path: P,
	): Omit<
		TableQuery<
			Tables,
			D,
			Extract<PathTarget<D, Extract<T, string>, P>, keyof Tables>,
			{},
			RemainingDepth<P, L>
		>,
		'relation'
	>
	paginate(args: EngineArgs<Tables, D, T>): Promise<PaginationResult<RelationRow<Tables, D, T, S>>>
}
export interface QueryEngineConfig<
	Schema extends SchemaDefinition<GenericSchema, boolean>,
	Tables extends RelationTables,
	D extends RelationDeclarations,
> {
	schema: Schema
	relations: RelationRegistry<Tables, D>
	cursor: CursorCodecConfig
	budgets?: Partial<ManagedBudgets>
	maxPageSize?: number
	policyVersion?: string
	engineVersion?: string
	trustedAdapter?: ManagedSecurityConfig<DataModelFromSchemaDefinition<Schema>>['trustedAdapter']
}

/** Central facade. Endpoint chains carry declarative constraints and explicit relationships. */
export function createQueryEngine<
	Schema extends SchemaDefinition<GenericSchema, boolean>,
	const Tables extends RelationTables,
	const D extends RelationDeclarations,
>(config: QueryEngineConfig<Schema, Tables, D>) {
	const { schema, relations } = config
	const planner = createPlanner(schema, relations)
	const codec = createCursorCodec(config.cursor)
	const maxPageSize = config.maxPageSize ?? 100
	if (!Number.isSafeInteger(maxPageSize) || maxPageSize <= 0 || maxPageSize > 100)
		throw new Error('Invalid central page size')
	const engineVersion = config.engineVersion ?? 'scalar-1'
	const policyVersion = config.policyVersion ?? '1'
	// Bind the full immutable identity through a collision-resistant digest so
	// real application registries fit the codec's bounded AAD. Live guards still
	// inspect current schemas; this caches only the immutable version identity.
	let registryDigest: string | undefined
	const security = createManagedSecurity<DataModelFromSchemaDefinition<Schema>>({
		tables: Object.keys(relations.tables),
		policyVersion,
		budgets: config.budgets,
		trustedAdapter: config.trustedAdapter,
	})
	function querying(ctx: ManagedQueryContext<DataModelFromSchemaDefinition<Schema>>) {
		planner.assertUnchanged()
		const request = security(ctx)
		function tableQuery(
			table: string,
			conditions: readonly IndexCondition[] = [],
			constraints: readonly StoredConstraint[] = [],
			selection: OutputSelection = {},
			route?: { table: string; parent: string; path: string[] },
		) {
			return Object.freeze({
				when: (value: IndexCondition['value'], index: string) =>
					tableQuery(table, [...conditions, { value, index }], constraints, selection, route),
				where: (spec: StoredConstraint) =>
					tableQuery(table, conditions, [...constraints, spec], selection, route),
				with: (selected: OutputSelection) =>
					tableQuery(table, conditions, constraints, selected, route),
				relation: (parent: string, declaredPath: string) => {
					const path = declaredPath.split('.')
					if (!path.length || path.length > 4) throw new Error('INVALID_RELATION')
					let target = table
					for (const name of path) {
						const edge = planner.metadata.declarations[target]?.[name]
						if (!edge) throw new Error('INVALID_RELATION')
						target = edge.target
					}
					return tableQuery(target, conditions, constraints, {}, { table, parent, path })
				},
				async paginate(input: QueryInput) {
					planner.assertUnchanged()
					const pageSchema = planner.page(table, selection)
					assertRelationshipDepth(selection, route?.path.length ?? 0)
					const plan = planner.plan(table, input, route ? [] : conditions, constraints)
					if (plan.args.numItems > maxPageSize) throw new Error('Page size exceeds central ceiling')
					// Native root limits stay native; lowering those limits cannot raise
					// the independent shared request meter.
					plan.args.maximumRowsRead = Math.min(
						plan.args.maximumRowsRead ?? request.budgets.rawCandidates,
						request.budgets.rawCandidates,
					)
					plan.args.maximumBytesRead = Math.min(
						plan.args.maximumBytesRead ?? request.budgets.documentBytes,
						request.budgets.documentBytes,
					)
					registryDigest ??= Array.from(
						new Uint8Array(
							await crypto.subtle.digest('SHA-256', new TextEncoder().encode(relations.identity)),
						),
						(byte) => byte.toString(16).padStart(2, '0'),
					).join('')
					// The digest await is a boundary too: mutation must be detected
					// before authenticated cursor validation or native query construction.
					planner.assertUnchanged()
					// SAFETY: selection has passed the registry page validator before binding.
					const binding: CursorBinding = {
						table: route?.table ?? table,
						index: plan.index?.name ?? 'by_creation_time',
						order: plan.args.order ?? 'asc',
						clientFilters: plan.clientIdentity,
						// Include output selection and the complete immutable scope in trusted identity.
						serverFilters: {
							predicates: plan.serverIdentity,
							selection: selection as import('convex/values').Value,
							scope: { ...request.scope },
						},
						relationPath: [],
						principal: JSON.stringify(request.scope),
						tenant: request.scope.tenant,
						policyVersion,
						engineVersion,
						registryVersion: registryDigest,
					}
					// The executor accepts registry-selected native tables, rather than a static DM key.
					const executorRequest: unknown = request
					// SAFETY: only native DM types are erased at this private executor boundary.
					const executor = relationshipExecutor(
						schema,
						executorRequest as ExecutionRequest,
						planner,
						codec,
						binding,
					)
					if (route)
						return executor.continuation(
							route.table,
							route.parent,
							route.path,
							selection,
							plan.args,
							conditions,
							constraints,
						)
					const result = await executeQuery(
						schema,
						request,
						table,
						plan,
						planner,
						codec,
						binding,
						async (row, permitted) => {
							// SAFETY: metered native stream rows contain the validated system fields.
							if (
								!permitted ||
								!(await executor.matches(table, row as RelationDocument, plan.residual))
							)
								return null
							// SAFETY: the same native row is authorized and matches the declared predicates.
							return executor.output(table, row as RelationDocument, selection, plan.args)
						},
					)
					planner.assertUnchanged()
					return pageSchema.parse(result)
				},
			})
		}
		// SAFETY: each key comes from the exact validated registry; the planner
		// validates all input and projection while mapped types retain table brands.
		return Object.freeze(
			Object.fromEntries(Object.keys(relations.tables).map((table) => [table, tableQuery(table)])),
		) as { [T in keyof Tables]: TableQuery<Tables, D, T> }
	}
	return Object.assign(querying, { tables: relations.tables })
}
