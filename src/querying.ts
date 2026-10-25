import type { GenericSchema, SchemaDefinition, DataModelFromSchemaDefinition } from 'convex/server'
import type { GenericId } from 'convex/values'
import type { EnginePaginationResult } from './zod-table'
import { z } from 'zod'
import type {
	RelationTables,
	RelationDeclarations,
	RelationRegistry,
	RelationQueryRow,
	RelationSelection,
	RelationFilters,
	RelationFilterSelection,
	FieldGroupRequest,
	RelationGroupSelection,
	GroupSelection,
	ExactGroupSelection,
} from './relations'
import { createPlanner, type QueryInput, type StoredConstraint } from './querying/planner'
import { executeQuery, type ExecutionRequest } from './querying/execution'
import {
	relationshipExecutor,
	assertRelationshipDepth,
	type OutputSelection,
	type RelationDocument,
	type GroupAccess,
	type ResolvedGroups,
} from './querying/relationships'
import {
	createCursorCodec,
	createScopedCursorCodec,
	type ScopedCursorOptions,
	type ScopedCursorCodec,
	createEnvironmentCursorCodec,
	type CursorCodecConfig,
	type CursorBinding,
} from './querying/cursors'
import {
	createManagedSecurity,
	type ManagedSecurityConfig,
	type ManagedQueryContext,
	type ManagedBudgets,
	type ManagedScope,
	ManagedReadError,
} from './querying/security'
import type { FilterAst, IndexCondition, NativePagination } from './querying/filters'
import type { GenericDatabaseReader } from 'convex/server'
import type { Value } from 'convex/values'

export { queryFailureContract } from './querying/failures'
export { CursorError } from './querying/cursors'
export type { ScopedCursorOptions, ScopedCursorCodec } from './querying/cursors'

const emptyGroups: ResolvedGroups = { fieldGroups: {}, relations: {} }

type FullMask<S> = {
	[K in keyof S]-?: NonNullable<S[K]> extends true
		? true
		: FullMask<Exclude<NonNullable<S[K]>, true>>
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
type PathScope<
	D extends RelationDeclarations,
	T extends string,
	P extends string,
> = P extends `${infer Head}.${infer Rest}`
	? PathScope<D, D[T][Head]['target'], Rest>
	: Extract<NonNullable<D[T][P]['targetGuard']>['tag'], string>
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
/** Typed declarative chain returned by the engine; named for consumer declaration emission. */
export interface TableQuery<
	Tables extends RelationTables,
	D extends RelationDeclarations,
	T extends keyof Tables,
	S = {},
	L extends readonly 1[] = [1, 1, 1, 1],
	Scope extends string = never,
	Schema extends SchemaDefinition<GenericSchema, boolean> = SchemaDefinition<
		GenericSchema,
		boolean
	>,
	G = {},
> {
	include<const Groups extends FieldGroupRequest<Tables[T]>>(
		groups: Groups & Record<Exclude<keyof Groups, keyof FieldGroupRequest<Tables[T]>>, never>,
	): TableQuery<Tables, D, T, S, L, Scope, Schema, Omit<G, 'fieldGroups'> & { fieldGroups: Groups }>
	orderBy(
		index: Exclude<
			Extract<keyof DataModelFromSchemaDefinition<Schema>[Extract<T, string>]['indexes'], string>,
			'by_id' | 'by_creation_time'
		>,
	): TableQuery<Tables, D, T, S, L, Scope, Schema, G>
	when(
		value: IndexCondition['value'],
		index: string,
	): TableQuery<Tables, D, T, S, L, Scope, Schema, G>
	where(
		spec: NonNullable<EngineArgs<Tables, D, T>['filters']>,
	): TableQuery<Tables, D, T, S, L, Scope, Schema, G>
	with<
		const Selection extends RelationSelection<Tables, D, T, L>,
		const Groups extends RelationGroupSelection<Tables, D, T, L> = {},
	>(
		selection: Selection & {
			[K in keyof Selection]: K extends keyof RelationSelection<Tables, D, T, L>
				? Selection[K]
				: never
		},
		groups?: ExactGroupSelection<Tables, D, T, Groups>,
	): TableQuery<Tables, D, T, Selection, L, Scope, Schema, Omit<G, keyof Groups> & Groups>
	relation<const P extends Paths<D, Extract<T, string>>>(
		parent: GenericId<Tables[T]['tableName']>,
		path: P,
	): Omit<
		TableQuery<
			Tables,
			D,
			Extract<PathTarget<D, Extract<T, string>, P>, keyof Tables>,
			{},
			RemainingDepth<P, L>,
			PathScope<D, Extract<T, string>, P>,
			Schema
		>,
		'relation'
	>
	paginate(
		args: EngineArgs<Tables, D, T>,
	): Promise<EnginePaginationResult<RelationQueryRow<Tables, D, T, S, Scope, G>>>
}
export interface QueryEngineDeclaration<
	Schema extends SchemaDefinition<GenericSchema, boolean>,
	Tables extends RelationTables,
	D extends RelationDeclarations,
> {
	schema: Schema
	relations: RelationRegistry<Tables, D>
}
/** Advanced server configuration, separate from the normal schema/relations declaration. */
export interface QueryEngineOptions<
	Schema extends SchemaDefinition<GenericSchema, boolean>,
	Tables extends RelationTables = RelationTables,
> {
	/** Explicit codecs validate at creation. Otherwise environment keys load at first paginate. */
	cursor?: CursorCodecConfig
	budgets?: Partial<ManagedBudgets>
	maxPageSize?: number
	policyVersion?: string
	engineVersion?: string
	trustedAdapter?: ManagedSecurityConfig<DataModelFromSchemaDefinition<Schema>>['trustedAdapter']
	fieldGroups?: {
		[T in keyof Tables]?: {
			[G in keyof NonNullable<Tables[T]['fieldGroups']>]?: (
				ctx: FieldGroupPolicyContext<Schema>,
			) => boolean | Promise<boolean>
		}
	}
}
export interface FieldGroupPolicyContext<Schema extends SchemaDefinition<GenericSchema, boolean>> {
	readonly db: GenericDatabaseReader<DataModelFromSchemaDefinition<Schema>>
	readonly scope: ManagedScope
}
export class FieldGroupError extends Error {
	readonly code = 'FIELD_GROUP_DENIED'
	constructor() {
		super('FIELD_GROUP_DENIED')
		this.name = 'FieldGroupError'
	}
}

/** @deprecated Use QueryEngineDeclaration and optional QueryEngineOptions separately. */
export interface QueryEngineConfig<
	Schema extends SchemaDefinition<GenericSchema, boolean>,
	Tables extends RelationTables,
	D extends RelationDeclarations,
>
	extends QueryEngineDeclaration<Schema, Tables, D>, QueryEngineOptions<Schema, Tables> {
	cursor: CursorCodecConfig
}

type QueryEngine<
	Schema extends SchemaDefinition<GenericSchema, boolean>,
	Tables extends RelationTables,
	D extends RelationDeclarations,
> = {
	(ctx: ManagedQueryContext<DataModelFromSchemaDefinition<Schema>>): {
		[T in keyof Tables]: TableQuery<Tables, D, T, {}, [1, 1, 1, 1], never, Schema>
	}
	/** Opens prove integrity only; native consumers must enforce current row authorization. */
	cursorCodec<S extends z.ZodType<Value>>(
		ctx: ManagedQueryContext<DataModelFromSchemaDefinition<Schema>>,
		options: ScopedCursorOptions<S>,
	): ScopedCursorCodec<S>
	tables: RelationRegistry<Tables, D>['tables']
}

/** Central facade. Endpoint chains carry declarative constraints and explicit relationships. */
export function createQueryEngine<
	Schema extends SchemaDefinition<GenericSchema, boolean>,
	const Tables extends RelationTables,
	const D extends RelationDeclarations,
>(
	config: QueryEngineDeclaration<Schema, Tables, D>,
	options?: QueryEngineOptions<Schema, Tables>,
): QueryEngine<Schema, Tables, D>
/** @deprecated Pass advanced fields in the optional second argument. */
export function createQueryEngine<
	Schema extends SchemaDefinition<GenericSchema, boolean>,
	const Tables extends RelationTables,
	const D extends RelationDeclarations,
>(
	config: QueryEngineDeclaration<Schema, Tables, D> &
		QueryEngineOptions<Schema, Tables> & { cursor: CursorCodecConfig },
): QueryEngine<Schema, Tables, D>
export function createQueryEngine<
	Schema extends SchemaDefinition<GenericSchema, boolean>,
	const Tables extends RelationTables,
	const D extends RelationDeclarations,
>(
	config: QueryEngineDeclaration<Schema, Tables, D> & QueryEngineOptions<Schema, Tables>,
	options?: QueryEngineOptions<Schema, Tables>,
) {
	const { relations } = config
	// Retain released one-argument calls; a second argument overrides legacy fields.
	const settings = { ...config, ...options }
	const planner = createPlanner(config.schema, relations)
	const schema = planner.streamSchema
	// Copy callback references once: later option mutation cannot replace engine authority.
	const policies = new Map<
		string,
		(ctx: FieldGroupPolicyContext<Schema>) => boolean | Promise<boolean>
	>()
	for (const [table, definitions] of Object.entries(settings.fieldGroups ?? {})) {
		if (!Object.hasOwn(planner.metadata.tables, table))
			throw new Error('Unknown field group policy table')
		for (const [name, policy] of Object.entries(definitions ?? {})) {
			if (
				!Object.hasOwn(planner.metadata.tables[table].fieldGroups, name) ||
				!(policy instanceof Function)
			)
				throw new Error('Unknown field group policy')
			// SAFETY: the public mapped options require this policy signature; the function check also rejects malformed JS callers.
			policies.set(
				JSON.stringify([table, name]),
				policy as (ctx: FieldGroupPolicyContext<Schema>) => boolean | Promise<boolean>,
			)
		}
	}
	let cursorCodec = settings.cursor === undefined ? undefined : createCursorCodec(settings.cursor)
	const maxPageSize = settings.maxPageSize ?? 100
	if (!Number.isSafeInteger(maxPageSize) || maxPageSize <= 0 || maxPageSize > 100)
		throw new Error('Invalid central page size')
	const engineVersion = settings.engineVersion ?? 'scalar-1'
	const policyVersion = settings.policyVersion ?? '1'
	// Bind the full immutable identity through a collision-resistant digest so
	// real application registries fit the codec's bounded AAD.
	let registryDigest: string | undefined
	const security = createManagedSecurity<DataModelFromSchemaDefinition<Schema>>({
		tables: Object.keys(relations.tables),
		policyVersion,
		budgets: settings.budgets,
		trustedAdapter: settings.trustedAdapter,
	})
	function querying(ctx: ManagedQueryContext<DataModelFromSchemaDefinition<Schema>>) {
		const request = security(ctx)
		const decisions = new Map<string, Promise<boolean>>()
		async function resolveGroups(table: string, groups: GroupSelection): Promise<ResolvedGroups> {
			const fieldGroups: ResolvedGroups['fieldGroups'] = {}
			for (const [name, mode] of Object.entries(groups.fieldGroups ?? {})) {
				const key = JSON.stringify([table, name])
				let decision = decisions.get(key)
				if (!decision) {
					decision = Promise.resolve().then(async () => {
						try {
							return (
								(await policies.get(key)?.(
									Object.freeze({ db: request.db, scope: request.scope }),
								)) === true
							)
						} catch (error) {
							if (error instanceof ManagedReadError) throw error
							throw new FieldGroupError()
						}
					})
					decisions.set(key, decision)
				}
				fieldGroups[name] = { mode, allowed: await decision }
				if (mode === 'required' && !fieldGroups[name].allowed) throw new FieldGroupError()
			}
			const nested: ResolvedGroups['relations'] = {}
			for (const [name, selection] of Object.entries(groups.relations ?? {}))
				nested[name] = await resolveGroups(
					planner.metadata.declarations[table][name].target,
					selection,
				)
			return { fieldGroups, relations: nested }
		}
		function tableQuery(
			table: string,
			conditions: readonly IndexCondition[] = [],
			constraints: readonly StoredConstraint[] = [],
			selection: OutputSelection = {},
			route?: { table: string; parent: string; path: string[] },
			ordering?: string,
			groups: GroupSelection = {},
		) {
			return Object.freeze({
				include: (fieldGroups: GroupSelection['fieldGroups']) =>
					tableQuery(
						table,
						conditions,
						constraints,
						selection,
						route,
						ordering,
						planner.groups(table, { ...groups, fieldGroups }),
					),
				orderBy: (index: string) => {
					if (!z.string().safeParse(index).success) throw new Error('Unknown ordering index')
					return tableQuery(table, conditions, constraints, selection, route, index, groups)
				},
				when: (value: IndexCondition['value'], index: string) =>
					tableQuery(
						table,
						[...conditions, { value, index }],
						constraints,
						selection,
						route,
						ordering,
						groups,
					),
				where: (spec: StoredConstraint) =>
					tableQuery(table, conditions, [...constraints, spec], selection, route, ordering, groups),
				with: (selected: OutputSelection, requested: GroupSelection = {}) =>
					tableQuery(
						table,
						conditions,
						constraints,
						selected,
						route,
						ordering,
						planner.groups(table, { ...groups, ...requested }),
					),
				relation: (parent: string, declaredPath: string) => {
					const path = declaredPath.split('.')
					if (!path.length || path.length > 4) throw new Error('INVALID_RELATION')
					let target = table
					for (const name of path) {
						const edge = planner.metadata.declarations[target]?.[name]
						if (!edge) throw new Error('INVALID_RELATION')
						target = edge.target
					}
					return tableQuery(target, conditions, constraints, {}, { table, parent, path }, ordering)
				},
				async paginate(input: QueryInput) {
					// Resolve once per global engine, before any native query or policy reads.
					const codec = (cursorCodec ??= createEnvironmentCursorCodec())
					planner.select(table, selection)
					assertRelationshipDepth(selection, route?.path.length ?? 0)
					const plan = planner.plan(
						table,
						input,
						route ? [] : conditions,
						constraints,
						ordering,
						route ? 'relation' : 'root',
					)
					if (plan.args.numItems > maxPageSize) throw new Error('Page size exceeds central ceiling')
					const resolved = await resolveGroups(table, planner.groups(table, groups))
					const groupAccess: GroupAccess = {
						at(path) {
							return path
								.slice(route?.path.length ?? 0)
								.reduce((node, name) => node.relations[name] ?? emptyGroups, resolved)
						},
						allowed(path) {
							return Object.entries(this.at(path).fieldGroups)
								.filter(([, decision]) => decision.allowed)
								.map(([name]) => name)
						},
						checkOrder(table, fields, path) {
							for (const field of fields)
								checkField(table, field, path ? this.at(path) : emptyGroups)
						},
					}
					function checkField(table: string, field: string, groups: ResolvedGroups) {
						for (const [name, fields] of Object.entries(planner.metadata.tables[table].fieldGroups))
							if (
								fields.includes(field.split('.')[0]) &&
								groups.fieldGroups[name]?.allowed !== true
							)
								throw new FieldGroupError()
					}
					function checkClient(table: string, ast: FilterAst, groups: ResolvedGroups): void {
						if (ast.kind === 'scalar') checkField(table, ast.field, groups)
						else if (ast.kind === 'variant') {
							checkField(table, ast.discriminator, groups)
							checkClient(table, ast.child, groups)
						} else if (ast.kind === 'not') checkClient(table, ast.child, groups)
						else if (ast.kind === 'and' || ast.kind === 'or')
							for (const child of ast.children) checkClient(table, child, groups)
						else if (ast.kind === 'relation' && ast.predicate)
							checkClient(
								planner.metadata.declarations[table][ast.name].target,
								ast.predicate,
								groups.relations[ast.name] ?? emptyGroups,
							)
					}
					// Inspect the whole client tree independently of execution/contradiction short circuits.
					if (plan.residual.kind !== 'and') throw new Error('Invalid compiled filter root')
					checkClient(table, plan.residual.children[0], resolved)
					const sortIndex =
						ordering ?? conditions.find((condition) => condition.value != null)?.index
					if (sortIndex !== undefined)
						for (const field of planner.metadata.tables[table].indexes.find(
							(index) => index.name === sortIndex,
						)?.fields ?? [])
							checkField(table, field, resolved)
					else if (!route && plan.index)
						for (const field of plan.index.fields.slice(plan.prefix.length))
							checkField(table, field, resolved)
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
					const groupBinding: Record<string, Value> = {}
					if (hasGroups(resolved)) groupBinding.fieldGroups = resolved
					// SAFETY: selection has passed registry admission before cursor binding.
					const binding: CursorBinding = {
						table: route?.table ?? table,
						index: plan.index?.name ?? 'by_creation_time',
						order: plan.args.order ?? 'asc',
						clientFilters: plan.clientIdentity,
						// Include output selection and the complete immutable scope in trusted identity.
						serverFilters: {
							predicates: plan.serverIdentity,
							selection: selection as import('convex/values').Value,
							...groupBinding,
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
						groupAccess,
					)
					executor.preflight(table, selection, plan.args, route?.path ?? [])
					const result = route
						? await executor.continuation(
								route.table,
								route.parent,
								route.path,
								selection,
								plan.args,
								conditions,
								constraints,
								ordering,
							)
						: await executeQuery(
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
					// SAFETY: the private executor validated and projected every row against
					// this registry's DTO and selected edges before assembling the page.
					return result as EnginePaginationResult<
						RelationQueryRow<Tables, D, keyof Tables, OutputSelection>
					>
				},
			})
		}
		// SAFETY: each key comes from the exact validated registry; the planner
		// validates all input and projection while mapped types retain table brands.
		return Object.freeze(
			Object.fromEntries(Object.keys(relations.tables).map((table) => [table, tableQuery(table)])),
		) as { [T in keyof Tables]: TableQuery<Tables, D, T, {}, [1, 1, 1, 1], never, Schema> }
	}
	return Object.assign(querying, {
		tables: relations.tables,
		cursorCodec<S extends z.ZodType<Value>>(
			ctx: ManagedQueryContext<DataModelFromSchemaDefinition<Schema>>,
			options: ScopedCursorOptions<S>,
		): ScopedCursorCodec<S> {
			// Admission precedes lazy key loading and all schema/codec operations.
			const scope = security.cursorScope(ctx)
			cursorCodec ??= createEnvironmentCursorCodec()
			return createScopedCursorCodec(cursorCodec.custom, scope, options)
		},
	})
}

function hasGroups(groups: ResolvedGroups): boolean {
	return (
		Object.keys(groups.fieldGroups).length > 0 || Object.values(groups.relations).some(hasGroups)
	)
}
