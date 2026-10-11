import type {
	GenericSchema,
	SchemaDefinition,
	DataModelFromSchemaDefinition,
	PaginationResult,
} from 'convex/server'
import type {
	RelationTables,
	RelationDeclarations,
	RelationRegistry,
	RelationRow,
	RelationSelection,
} from './relations'
import { createPlanner, type QueryInput, type StoredConstraint } from './querying/planner'
import { executeScalar } from './querying/execution'
import { createCursorCodec, type CursorCodecConfig, type CursorBinding } from './querying/cursors'
import {
	createManagedSecurity,
	type ManagedSecurityConfig,
	type ManagedQueryContext,
	type ManagedBudgets,
} from './querying/security'
import type {
	IndexCondition,
	ServerFilter,
	ScalarFilters,
	ScalarSelection,
	NativePagination,
} from './querying/filters'

interface OutputSelection {
	[relation: string]: true | OutputSelection
}

type EngineArgs<Table extends RelationTables[string]> = NativePagination & {
	filters?: ScalarFilters<Table['schema']['shape'], ScalarSelection<Table['schema']['shape']>>
	order?: 'asc' | 'desc'
}
interface TableQuery<
	Tables extends RelationTables,
	D extends RelationDeclarations,
	T extends keyof Tables,
	S = {},
> {
	when(value: IndexCondition['value'], index: string): TableQuery<Tables, D, T, S>
	where(spec: ServerFilter<Tables[T]['schema']['shape']>): TableQuery<Tables, D, T, S>
	with<const Selection extends RelationSelection<Tables, D, T>>(
		selection: Selection & {
			[K in keyof Selection]: K extends keyof RelationSelection<Tables, D, T> ? Selection[K] : never
		},
	): TableQuery<Tables, D, T, Selection>
	paginate(args: EngineArgs<Tables[T]>): Promise<PaginationResult<RelationRow<Tables, D, T, S>>>
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

/** Central facade. Endpoint chains carry declarative constraints only. Relation
 * execution is U6; selecting a relation here fails visibly instead of omitting it.
 */
export function createQueryEngine<
	Schema extends SchemaDefinition<GenericSchema, boolean>,
	const Tables extends RelationTables,
	const D extends RelationDeclarations,
>(config: QueryEngineConfig<Schema, Tables, D>) {
	const { schema, relations } = config
	const planner = createPlanner(schema, relations)
	const codec = createCursorCodec(config.cursor)
	const pages = new Map(
		Object.keys(relations.tables).map((table) => [table, relations.tables[table].pageDto({})]),
	)
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
		) {
			return Object.freeze({
				when: (value: IndexCondition['value'], index: string) =>
					tableQuery(table, [...conditions, { value, index }], constraints, selection),
				where: (spec: StoredConstraint) =>
					tableQuery(table, conditions, [...constraints, spec], selection),
				with: (selected: OutputSelection) => tableQuery(table, conditions, constraints, selected),
				async paginate(input: QueryInput) {
					planner.assertUnchanged()
					if (Reflect.ownKeys(selection).length) throw new Error('Relation execution requires U6')
					const plan = planner.plan(table, input, conditions, constraints)
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
					const binding: CursorBinding = {
						table,
						index: plan.index?.name ?? 'by_creation_time',
						order: plan.args.order ?? 'asc',
						clientFilters: plan.clientIdentity,
						// Include output selection and the complete immutable scope in trusted identity.
						serverFilters: {
							predicates: plan.serverIdentity,
							selection: {},
							scope: { ...request.scope },
						},
						relationPath: [],
						principal: JSON.stringify(request.scope),
						tenant: request.scope.tenant,
						policyVersion,
						engineVersion,
						registryVersion: registryDigest,
					}
					const result = await executeScalar(schema, request, table, plan, planner, codec, binding)
					planner.assertUnchanged()
					return pages.get(table)!.parse(result)
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
