import {
	zCustomAction,
	zCustomMutation,
	zCustomQuery,
} from 'convex-helpers/server/zod4'
import type {
	ActionBuilder,
	DocumentByInfo,
	GenericActionCtx,
	GenericDataModel,
	GenericMutationCtx,
	GenericQueryCtx,
	GenericTableInfo,
	IndexNames,
	IndexRange,
	IndexRangeBuilder,
	MutationBuilder,
	NamedIndex,
	Query,
	QueryBuilder,
	QueryInitializer,
	UserIdentity,
} from 'convex/server'
import type { Triggers } from 'convex-helpers/server/triggers'
import type { TableNamesInDataModel } from 'convex/server'
import { defaultErrors, type ErrorFactory } from './errors'
import {
	composeRules,
	createTenantRules,
	wrapDatabaseReader,
	wrapDatabaseWriter,
	type RLSConfig,
	type Rules,
} from './tenancy'

/** The default vocabulary; every app can supply its own via the Role generic. */
export type DefaultRole = 'reader' | 'writer' | 'admin'

export type Actor<Role extends string> = Readonly<{
	userId: string
	organizationId: string
	role: Role
}>

export type AuthBundle<Role extends string> = Readonly<{
	identity: UserIdentity
	user: Readonly<{ id: string }>
	org: Readonly<{ organizationId: string; role: Role }>
	role: Role
	actor: Actor<Role>
	/** The resolved tenant — security.tenancy.resolve, or the organization id. */
	tenant: string
}>

/**
 * Row-level security configuration. Tenant isolation and role-level rules
 * compose (AND) onto the same wrapped database: queries get a wrapped
 * reader, mutations get triggers first, then a wrapped writer.
 */
export type SecurityConfig<
	DataModel extends GenericDataModel,
	Role extends string,
> = {
	/**
	 * Tenant isolation. `tables` is THE registry: every listed table gets
	 * read/insert/modify gated on row.tenant === ctx.tenant. Pair with
	 * tenantTable (schema) and tenantOwnership (triggers) on the same list.
	 */
	tenancy?: {
		tables: readonly TableNamesInDataModel<DataModel>[]
		/** Maps the auth bundle to the tenant; defaults to org.organizationId. */
		resolve?: (bundle: Omit<AuthBundle<Role>, 'tenant'>) => string
	}
	/**
	 * Role-level (or any policy) rules derived from the authenticated bundle,
	 * composed AND-wise with tenant isolation. E.g. gate `modify` on a table
	 * to admin roles.
	 */
	rules?: (bundle: AuthBundle<Role>) => Rules<unknown, DataModel>
	/**
	 * Policy for tables with no rule. Defaults to 'deny' when tenancy is
	 * configured (unlisted tables are unreachable — fail closed), 'allow'
	 * otherwise.
	 */
	defaultPolicy?: RLSConfig['defaultPolicy']
}

type AnyAuthContext<DataModel extends GenericDataModel> =
	| GenericQueryCtx<DataModel>
	| GenericMutationCtx<DataModel>
	| GenericActionCtx<DataModel>

export type AuthFunctionsConfig<
	DataModel extends GenericDataModel,
	Role extends string,
> = {
	/** The consumer's generated function builders (from ./_generated/server). */
	query: QueryBuilder<DataModel, 'public'>
	mutation: MutationBuilder<DataModel, 'public'>
	action: ActionBuilder<DataModel, 'public'>
	internalQuery: QueryBuilder<DataModel, 'internal'>
	internalMutation: MutationBuilder<DataModel, 'internal'>
	internalAction: ActionBuilder<DataModel, 'internal'>
	/** Resolves the synchronized principal, e.g. (ctx) => authKit.getAuthUser(ctx). */
	getAuthUser: (
		ctx: AnyAuthContext<DataModel>,
	) => Promise<{ id: string } | null>
	/**
	 * Maps an identity role slug onto the app's role vocabulary. Returning
	 * null rejects the caller with FORBIDDEN — unknown roles never pass.
	 */
	mapRole: (roleSlug?: string) => Role | null
	/** Roles allowed through the admin* constructors. */
	adminRoles: readonly NoInfer<Role>[]
	/**
	 * Live membership check for actions (queries/mutations trust the JWT).
	 * Authentication fails closed with FORBIDDEN when verification errors.
	 * Omit to let actions trust the JWT like queries do.
	 */
	verifyMembership?: (input: {
		userId: string
		organizationId: string
	}) => Promise<{ organizationId: string; roleSlug: string } | null>
	/** Host error policy; defaults to throwing KitError. */
	errors?: ErrorFactory
	/**
	 * Application trigger registry. When set, every authMutation,
	 * roleMutation, and systemMutation write runs through triggers.wrapDB —
	 * evaluations registered on tables fire structurally.
	 */
	triggers?: Triggers<DataModel>
	/** Lower-level alternative to `triggers`: a custom ctx wrapper. */
	wrapDB?: (
		ctx: GenericMutationCtx<DataModel>,
	) => GenericMutationCtx<DataModel>
	/** Upper bound for include() reads. */
	maxIncludedQueryRows?: number
	/**
	 * Row-level security: tenant isolation (from a table registry) and
	 * role-level rules, applied structurally inside every auth*, role*, and
	 * admin* constructor. system* constructors stay unwrapped (trusted).
	 */
	security?: SecurityConfig<DataModel, Role>
}

/** WorkOS-style default: `member` writes; reader/writer/admin pass through. */
export function defaultRoleMap(roleSlug?: string): DefaultRole | null {
	const normalized = roleSlug?.trim().toLowerCase()
	if (normalized === 'member') return 'writer'
	return normalized === 'reader' ||
		normalized === 'writer' ||
		normalized === 'admin'
		? normalized
		: null
}

export type IncludedQuery<Table extends GenericTableInfo> = {
	when<Value>(
		value: Value | null | undefined,
		select: (query: QueryInitializer<Table>, value: Value) => Query<Table>,
	): IncludedQuery<Table>
	matching<IndexName extends IndexNames<Table>>(
		indexName: IndexName,
		indexRange?: (
			query: IndexRangeBuilder<
				DocumentByInfo<Table>,
				NamedIndex<Table, IndexName>
			>,
		) => IndexRange,
		shouldMatch?: boolean,
	): IncludedQuery<Table>
	otherwise(
		select: (query: QueryInitializer<Table>) => Query<Table>,
	): Query<Table>
	resolve(): Query<Table>
	execute<Result = Awaited<ReturnType<Query<Table>['take']>>>(
		limit: number,
		transform?: (
			data: Awaited<ReturnType<Query<Table>['take']>>,
		) => Result | Promise<Result>,
	): Promise<Result>
}

export type Include = <Table extends GenericTableInfo>(
	query: QueryInitializer<Table>,
) => IncludedQuery<Table>

/** Builds an include() that selects the first matching indexed query and bounds the read. */
export function createInclude(options?: {
	errors?: ErrorFactory
	maxRows?: number
}): Include {
	const errors = options?.errors ?? defaultErrors
	const maxRows = options?.maxRows ?? 100

	function attach<Table extends GenericTableInfo>(
		query: QueryInitializer<Table>,
		selected?: Query<Table>,
	): IncludedQuery<Table> {
		return {
			when: (value, select) =>
				selected || value === undefined || value === null
					? attach(query, selected)
					: attach(query, select(query, value)),
			matching: (indexName, indexRange, shouldMatch = true) =>
				selected || !shouldMatch
					? attach(query, selected)
					: attach(query, query.withIndex(indexName, indexRange)),
			otherwise: (select) => selected ?? select(query),
			resolve: () => selected ?? query.fullTableScan(),
			execute: async (limit, transform) => {
				if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxRows) {
					return errors.throw({
						code: 'INVALID_REQUEST_BOUNDARY',
						message: `A bounded query limit must be from 1 to ${maxRows}`,
					})
				}
				const data = await (selected ?? query.fullTableScan()).take(limit)
				return transform ? transform(data) : (data as never)
			},
		}
	}

	return (query) => attach(query)
}

/**
 * Builds the auth-aware function constructors from the host's injected
 * policy: identity resolution, the app's own role vocabulary, live
 * membership verification for actions, trigger wrapping for mutations,
 * and errors. Role-based access is first-class — every constructor family
 * has a role-gated variant (roleQuery/roleMutation/roleAction), and the
 * admin* constructors are just that gate applied to config.adminRoles.
 */
export function createAuthFunctions<
	DataModel extends GenericDataModel,
	const Role extends string = DefaultRole,
>(config: AuthFunctionsConfig<DataModel, Role>) {
	const errors = config.errors ?? defaultErrors
	const wrapDB = config.triggers
		? (ctx: GenericMutationCtx<DataModel>) =>
				(config.triggers as Triggers<DataModel>).wrapDB(ctx)
		: (config.wrapDB ?? ((ctx) => ctx))
	const include = createInclude({
		errors,
		maxRows: config.maxIncludedQueryRows,
	})

	async function authenticatedUser(
		ctx: AnyAuthContext<DataModel>,
	): Promise<AuthBundle<Role>> {
		const identity = await ctx.auth.getUserIdentity()
		const user = identity ? await config.getAuthUser(ctx) : null
		if (!identity || !user) return errors.throw({ code: 'UNAUTHENTICATED' })
		const organization = identity.organization
		const organizationId =
			organization &&
			typeof organization === 'object' &&
			'organizationId' in organization &&
			typeof organization.organizationId === 'string'
				? organization.organizationId
				: typeof identity.org_id === 'string'
					? identity.org_id
					: null
		if (!organizationId) return errors.throw({ code: 'UNAUTHENTICATED' })
		const organizationRole =
			organization &&
			typeof organization === 'object' &&
			'role' in organization &&
			typeof organization.role === 'string'
				? organization.role
				: typeof identity.role === 'string'
					? identity.role
					: undefined
		const role = config.mapRole(organizationRole)
		if (!role) return errors.throw({ code: 'FORBIDDEN' })
		const base = {
			identity,
			user: Object.freeze({ id: user.id }),
			org: Object.freeze({ organizationId, role }),
			role,
			actor: Object.freeze({ userId: user.id, organizationId, role }),
		}
		return Object.freeze({
			...base,
			tenant: config.security?.tenancy?.resolve?.(base) ?? organizationId,
		})
	}

	const securityConfig: RLSConfig | undefined = config.security
		? {
				defaultPolicy:
					config.security.defaultPolicy ??
					(config.security.tenancy ? 'deny' : 'allow'),
			}
		: undefined

	function securityRules(
		bundle: AuthBundle<Role>,
	): Rules<unknown, DataModel> | undefined {
		const security = config.security
		if (!security) return undefined
		const sets: Rules<unknown, DataModel>[] = []
		if (security.tenancy) {
			sets.push(
				createTenantRules<DataModel>(bundle.tenant, security.tenancy.tables),
			)
		}
		if (security.rules) sets.push(security.rules(bundle))
		return sets.length === 1 ? sets[0] : composeRules(...sets)
	}

	function secureReader(
		ctx: GenericQueryCtx<DataModel>,
		bundle: AuthBundle<Role>,
	): GenericQueryCtx<DataModel> {
		const rules = securityRules(bundle)
		if (!rules) return ctx
		return {
			...ctx,
			db: wrapDatabaseReader({}, ctx.db, rules as never, securityConfig),
		}
	}

	function secureWriter(
		ctx: GenericMutationCtx<DataModel>,
		bundle: AuthBundle<Role>,
	): GenericMutationCtx<DataModel> {
		const rules = securityRules(bundle)
		if (!rules) return ctx
		// Triggers wrap first (ctx already trigger-wrapped by the caller),
		// then row-level security wraps the triggered db — order matters.
		return {
			...ctx,
			db: wrapDatabaseWriter({}, ctx.db, rules as never, securityConfig),
		}
	}

	async function verifiedMembership(userId: string, organizationId: string) {
		if (!config.verifyMembership) return null
		try {
			const membership = await config.verifyMembership({
				userId,
				organizationId,
			})
			if (membership && membership.organizationId === organizationId) {
				return membership
			}
		} catch {
			// Authentication fails closed when membership cannot be verified.
		}
		return errors.throw({ code: 'FORBIDDEN' })
	}

	function requireRole(role: Role, allowed: readonly Role[]) {
		if (!allowed.includes(role)) return errors.throw({ code: 'FORBIDDEN' })
	}

	async function queryInput(ctx: GenericQueryCtx<DataModel>) {
		const bundle = await authenticatedUser(ctx)
		return {
			ctx: { ...secureReader(ctx, bundle), include, ...bundle },
			args: {},
		}
	}

	async function mutationInput(ctx: GenericMutationCtx<DataModel>) {
		const bundle = await authenticatedUser(ctx)
		return {
			ctx: { ...secureWriter(wrapDB(ctx), bundle), include, ...bundle },
			args: {},
		}
	}

	async function actionInput(ctx: GenericActionCtx<DataModel>) {
		const authenticated = await authenticatedUser(ctx)
		const membership = await verifiedMembership(
			authenticated.user.id,
			authenticated.org.organizationId,
		)
		if (!membership) return { ctx: { ...ctx, ...authenticated }, args: {} }
		const role = config.mapRole(membership.roleSlug)
		if (!role) return errors.throw({ code: 'FORBIDDEN' })
		const verified = {
			identity: authenticated.identity,
			user: authenticated.user,
			org: Object.freeze({
				organizationId: membership.organizationId,
				role,
			}),
			role,
			actor: Object.freeze({
				userId: authenticated.user.id,
				organizationId: membership.organizationId,
				role,
			}),
		}
		return {
			ctx: {
				...ctx,
				...verified,
				// Tenant re-derives from the live-verified organization.
				tenant:
					config.security?.tenancy?.resolve?.(verified) ??
					membership.organizationId,
			},
			args: {},
		}
	}

	/** Query constructor allowing only the given roles. */
	function roleQuery(...allowed: readonly Role[]) {
		return zCustomQuery(config.query, {
			args: {},
			input: async (ctx) => {
				const authenticated = await queryInput(ctx)
				requireRole(authenticated.ctx.actor.role, allowed)
				return authenticated
			},
		})
	}

	/** Mutation constructor allowing only the given roles. */
	function roleMutation(...allowed: readonly Role[]) {
		return zCustomMutation(config.mutation, {
			args: {},
			input: async (ctx) => {
				const authenticated = await mutationInput(ctx)
				requireRole(authenticated.ctx.actor.role, allowed)
				return authenticated
			},
		})
	}

	/** Action constructor allowing only the given roles (post live verification). */
	function roleAction(...allowed: readonly Role[]) {
		return zCustomAction(config.action, {
			args: {},
			input: async (ctx) => {
				const authenticated = await actionInput(ctx)
				requireRole(authenticated.ctx.actor.role, allowed)
				return authenticated
			},
		})
	}

	return {
		include,
		authenticatedUser,
		roleQuery,
		roleMutation,
		roleAction,
		authQuery: zCustomQuery(config.query, { args: {}, input: queryInput }),
		authMutation: zCustomMutation(config.mutation, {
			args: {},
			input: mutationInput,
		}),
		authAction: zCustomAction(config.action, {
			args: {},
			input: actionInput,
		}),
		adminQuery: roleQuery(...config.adminRoles),
		adminMutation: roleMutation(...config.adminRoles),
		adminAction: roleAction(...config.adminRoles),
		systemQuery: zCustomQuery(config.internalQuery, {
			args: {},
			input: async (ctx) => ({ ctx: { ...ctx, include }, args: {} }),
		}),
		systemMutation: zCustomMutation(config.internalMutation, {
			args: {},
			input: async (ctx) => ({ ctx: { ...wrapDB(ctx), include }, args: {} }),
		}),
		systemAction: zCustomAction(config.internalAction, {
			args: {},
			input: async (ctx) => ({ ctx, args: {} }),
		}),
	}
}
