import type { Context } from 'effect'
import type {
	GenericDataModel,
	GenericQueryCtx,
	GenericMutationCtx,
	GenericActionCtx,
} from 'convex/server'
import type { CustomBuilder } from 'convex-helpers/server/zod4'
import {
	createAuthFunctions,
	type AuthFunctions,
	type AuthFunctionsConfig,
	type AuthBundle,
	type DefaultRole,
	type Include,
	type ServicePrincipal,
	type ServiceQuery,
	type ServiceMutation,
} from '../../auth'
import { effectZodApiBuilder, type EffectZodApiBuilder } from './api-zod'
import {
	wrapEffectBuilder,
	type EffectApiOptions,
	type EffectApiServices,
	type EffectApiContext,
	type ProvidedServices,
} from './api-runtime'
import type { EffectValue } from './operation'

// Derive the adapter from the symbolic auth contract, never from inferred native spreads.
type Adapted<Builder, Services, Added> =
	Builder extends CustomBuilder<
		infer Kind,
		infer Args,
		infer Ctx,
		infer Made,
		infer Input,
		infer Visibility,
		infer Extra
	>
		? EffectZodApiBuilder<
				Kind,
				Args,
				Ctx,
				Made,
				Input,
				Visibility,
				Extra,
				ProvidedServices<Services>,
				EffectValue<Added>,
				Added
			>
		: never

/** Shared post-auth composition; internal/system policies are configured separately. */
export type EffectAuthFunctions<
	DataModel extends GenericDataModel,
	Role extends string = DefaultRole,
	QueryServices extends EffectApiServices = Context.Context<never>,
	QueryAdded extends EffectApiContext = {},
	MutationServices extends EffectApiServices = Context.Context<never>,
	MutationAdded extends EffectApiContext = {},
	ActionServices extends EffectApiServices = Context.Context<never>,
	ActionAdded extends EffectApiContext = {},
	SystemQueryServices extends EffectApiServices = Context.Context<never>,
	SystemQueryAdded extends EffectApiContext = {},
	SystemMutationServices extends EffectApiServices = Context.Context<never>,
	SystemMutationAdded extends EffectApiContext = {},
	SystemActionServices extends EffectApiServices = Context.Context<never>,
	SystemActionAdded extends EffectApiContext = {},
> = Pick<AuthFunctions<DataModel, Role>, 'include' | 'authenticatedUser'> & {
	authQuery: Adapted<AuthFunctions<DataModel, Role>['authQuery'], QueryServices, QueryAdded>
	roleQuery: (
		...allowed: readonly Role[]
	) => Adapted<AuthFunctions<DataModel, Role>['authQuery'], QueryServices, QueryAdded>
	adminQuery: Adapted<AuthFunctions<DataModel, Role>['authQuery'], QueryServices, QueryAdded>
	authMutation: Adapted<
		AuthFunctions<DataModel, Role>['authMutation'],
		MutationServices,
		MutationAdded
	>
	roleMutation: (
		...allowed: readonly Role[]
	) => Adapted<AuthFunctions<DataModel, Role>['authMutation'], MutationServices, MutationAdded>
	adminMutation: Adapted<
		AuthFunctions<DataModel, Role>['authMutation'],
		MutationServices,
		MutationAdded
	>
	authAction: Adapted<AuthFunctions<DataModel, Role>['authAction'], ActionServices, ActionAdded>
	roleAction: (
		...allowed: readonly Role[]
	) => Adapted<AuthFunctions<DataModel, Role>['authAction'], ActionServices, ActionAdded>
	adminAction: Adapted<AuthFunctions<DataModel, Role>['authAction'], ActionServices, ActionAdded>
	/** Service principals share the `query` policy; the host factory is the only principal source. */
	serviceQuery: <Extra extends Record<string, unknown> = {}>(
		principal: ServicePrincipal<GenericQueryCtx<DataModel>, Role, Extra>,
	) => Adapted<ServiceQuery<DataModel, Role, Extra>, QueryServices, QueryAdded>
	/** Service principals share the `mutation` policy. */
	serviceMutation: <Extra extends Record<string, unknown> = {}>(
		principal: ServicePrincipal<GenericMutationCtx<DataModel>, Role, Extra>,
	) => Adapted<ServiceMutation<DataModel, Role, Extra>, MutationServices, MutationAdded>
	systemQuery: Adapted<
		AuthFunctions<DataModel, Role>['systemQuery'],
		SystemQueryServices,
		SystemQueryAdded
	>
	systemMutation: Adapted<
		AuthFunctions<DataModel, Role>['systemMutation'],
		SystemMutationServices,
		SystemMutationAdded
	>
	systemAction: Adapted<
		AuthFunctions<DataModel, Role>['systemAction'],
		SystemActionServices,
		SystemActionAdded
	>
}

/** Providers and handles run once per invocation after security and live role checks. */
export function createEffectAuthFunctions<
	DataModel extends GenericDataModel,
	const Role extends string = DefaultRole,
	QueryServices extends EffectApiServices = Context.Context<never>,
	QueryAdded extends EffectApiContext = {},
	MutationServices extends EffectApiServices = Context.Context<never>,
	MutationAdded extends EffectApiContext = {},
	ActionServices extends EffectApiServices = Context.Context<never>,
	ActionAdded extends EffectApiContext = {},
	SystemQueryServices extends EffectApiServices = Context.Context<never>,
	SystemQueryAdded extends EffectApiContext = {},
	SystemMutationServices extends EffectApiServices = Context.Context<never>,
	SystemMutationAdded extends EffectApiContext = {},
	SystemActionServices extends EffectApiServices = Context.Context<never>,
	SystemActionAdded extends EffectApiContext = {},
>(
	config: AuthFunctionsConfig<DataModel, Role>,
	options: {
		query: EffectApiOptions<
			GenericQueryCtx<DataModel> & AuthBundle<Role> & { include: Include },
			QueryServices,
			QueryAdded
		>
		mutation: EffectApiOptions<
			GenericMutationCtx<DataModel> & AuthBundle<Role> & { include: Include },
			MutationServices,
			MutationAdded
		>
		action: EffectApiOptions<
			GenericActionCtx<DataModel> & AuthBundle<Role>,
			ActionServices,
			ActionAdded
		>
		systemQuery: EffectApiOptions<
			GenericQueryCtx<DataModel> & { include: Include },
			SystemQueryServices,
			SystemQueryAdded
		>
		systemMutation: EffectApiOptions<
			GenericMutationCtx<DataModel> & { include: Include },
			SystemMutationServices,
			SystemMutationAdded
		>
		systemAction: EffectApiOptions<
			GenericActionCtx<DataModel>,
			SystemActionServices,
			SystemActionAdded
		>
	},
): EffectAuthFunctions<
	DataModel,
	Role,
	QueryServices,
	QueryAdded,
	MutationServices,
	MutationAdded,
	ActionServices,
	ActionAdded,
	SystemQueryServices,
	SystemQueryAdded,
	SystemMutationServices,
	SystemMutationAdded,
	SystemActionServices,
	SystemActionAdded
> {
	const auth = createAuthFunctions(config)
	return {
		include: auth.include,
		authenticatedUser: auth.authenticatedUser,
		authQuery: effectZodApiBuilder(auth.authQuery, options.query),
		roleQuery: (...allowed) => effectZodApiBuilder(auth.roleQuery(...allowed), options.query),
		adminQuery: effectZodApiBuilder(auth.adminQuery, options.query),
		authMutation: effectZodApiBuilder(auth.authMutation, options.mutation),
		roleMutation: (...allowed) =>
			effectZodApiBuilder(auth.roleMutation(...allowed), options.mutation),
		adminMutation: effectZodApiBuilder(auth.adminMutation, options.mutation),
		authAction: effectZodApiBuilder(auth.authAction, options.action),
		roleAction: (...allowed) => effectZodApiBuilder(auth.roleAction(...allowed), options.action),
		adminAction: effectZodApiBuilder(auth.adminAction, options.action),
		serviceQuery: <Extra extends Record<string, unknown> = {}>(
			principal: ServicePrincipal<GenericQueryCtx<DataModel>, Role, Extra>,
		) =>
			adaptService<ServiceQuery<DataModel, Role, Extra>, QueryServices, QueryAdded>(
				auth.serviceQuery(principal),
				options.query,
			),
		serviceMutation: <Extra extends Record<string, unknown> = {}>(
			principal: ServicePrincipal<GenericMutationCtx<DataModel>, Role, Extra>,
		) =>
			adaptService<ServiceMutation<DataModel, Role, Extra>, MutationServices, MutationAdded>(
				auth.serviceMutation(principal),
				options.mutation,
			),
		systemQuery: effectZodApiBuilder(auth.systemQuery, options.systemQuery),
		systemMutation: effectZodApiBuilder(auth.systemMutation, options.systemMutation),
		systemAction: effectZodApiBuilder(auth.systemAction, options.systemAction),
	}
}

/** Service builders reuse the query/mutation policy; the ctx adds only host extras. */
function adaptService<Builder extends Function, Services extends EffectApiServices, Added>(
	builder: Builder,
	options: Parameters<typeof wrapEffectBuilder>[1],
): Adapted<Builder, Services, Added> {
	// SAFETY: the shared policy callbacks read only the standard auth bundle, which every
	// service ctx carries; wrapEffectBuilder swaps the handler and keeps the builder's
	// registration kind, validation and visibility, as effectZodApiBuilder does.
	return wrapEffectBuilder(builder, options) as Adapted<Builder, Services, Added>
}
