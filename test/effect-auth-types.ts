// Also compiled as an external consumer against the packed public package.
import {
	actionGeneric,
	defineSchema,
	defineTable,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	mutationGeneric,
	queryGeneric,
	makeFunctionReference,
	type DataModelFromSchemaDefinition,
	type GenericQueryCtx,
	type GenericMutationCtx,
	type GenericActionCtx,
	type ApiFromModules,
	type FunctionArgs,
	type FunctionReturnType,
} from 'convex/server'
import { v } from 'convex/values'
import { Context, Effect } from 'effect'
import { z } from 'zod'
import type { AuthFunctionsConfig, AuthBundle } from 'cvx-kit/auth'
import { createEffectAuthFunctions, createEffectFoundation } from 'cvx-kit/effect'

const schema = defineSchema({ notes: defineTable({ title: v.string() }) })
type Model = DataModelFromSchemaDefinition<typeof schema>
type Role = 'owner' | 'viewer'
const config: AuthFunctionsConfig<Model, Role> = {
	query: queryGeneric,
	mutation: mutationGeneric,
	action: actionGeneric,
	internalQuery: internalQueryGeneric,
	internalMutation: internalMutationGeneric,
	internalAction: internalActionGeneric,
	getAuthUser: async () => ({ id: 'user' }),
	mapRole: (slug) => (slug === 'owner' || slug === 'viewer' ? slug : null),
	adminRoles: ['owner'],
}
class Actor extends Context.Service<Actor, string>()('SharedActor') {}
class Missing extends Context.Service<Missing, string>()('Missing') {}
const foundation = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
	},
	writeAudit: () => undefined,
})
const commands = foundation.Command({
	context: (ctx: GenericMutationCtx<Model> & AuthBundle<Role>) => ctx,
	operations: ({ command }) => ({
		write: command({
			input: z.object({}),
			result: z.null(),
			classification: 'business',
			audit: () => null,
			handler: () => null,
		}),
	}),
})
const queries = foundation.Query({
	context: (ctx: (GenericQueryCtx<Model> | GenericMutationCtx<Model>) & AuthBundle<Role>) => ctx,
	operations: ({ query }) => ({
		read: query({ input: z.object({}), result: z.null(), handler: () => null }),
	}),
})
const remote = makeFunctionReference<'mutation', {}, null>('notes:write')
const functions = createEffectAuthFunctions(config, {
	query: {
		services: (ctx) => Context.make(Actor, ctx.actor.userId),
		context: (ctx) =>
			Effect.gen(function* () {
				const actor = yield* Actor
				return { queries: queries.withContext(ctx), actorLabel: actor }
			}),
	},
	mutation: {
		context: (ctx) => ({ queries: queries.withContext(ctx), commands: commands.withContext(ctx) }),
	},
	action: {
		context: (ctx) => ({
			commands: { write: () => Effect.promise(() => ctx.runMutation(remote, {})) },
		}),
	},
	systemQuery: { context: (ctx) => ({ native: ctx }) },
	systemMutation: { context: (ctx) => ({ native: ctx }) },
	systemAction: { context: (ctx) => ({ native: ctx }) },
})
for (const builder of [functions.authQuery, functions.roleQuery('owner'), functions.adminQuery]) {
	builder({
		args: {},
		returns: z.null(),
		handler: (ctx) => {
			const role: Role = ctx.role
			const label: string = ctx.actorLabel
			const reader: GenericQueryCtx<Model> = ctx
			void role
			void label
			void reader
			// @ts-expect-error queries do not have commands
			void ctx.commands
			// @ts-expect-error query contexts cannot bind mutation commands
			commands.withContext(ctx)
			return ctx.queries.exec('read', {})
		},
	})
}
for (const builder of [
	functions.authMutation,
	functions.roleMutation('owner'),
	functions.adminMutation,
]) {
	builder({
		args: {},
		handler: (ctx) => {
			const writer: GenericMutationCtx<Model> = ctx
			const role: Role = ctx.actor.role
			void writer
			void role
			ctx.queries.exec('read', {})
			return ctx.commands.exec('write', {})
		},
	})
}
for (const builder of [
	functions.authAction,
	functions.roleAction('owner'),
	functions.adminAction,
]) {
	builder({
		args: {},
		handler: (ctx) => {
			const action: GenericActionCtx<Model> = ctx
			const role: Role = ctx.org.role
			void action
			void role
			// @ts-expect-error actions cannot bind mutation DB commands
			commands.withContext(ctx)
			// @ts-expect-error actions do not have a DB
			void ctx.db
			return ctx.commands.write()
		},
	})
}
functions.systemQuery({
	args: {},
	handler: (ctx) => {
		const native: GenericQueryCtx<Model> = ctx.native
		void native
		// @ts-expect-error system policy does not invent an actor
		void ctx.actor
		// @ts-expect-error public query handles are not inherited
		void ctx.queries
		return null
	},
})
functions.systemMutation({
	args: {},
	handler: (ctx) => {
		const native: GenericMutationCtx<Model> = ctx.native
		void native
		// @ts-expect-error public command handles are not inherited
		void ctx.commands
		return null
	},
})
functions.systemAction({
	args: {},
	handler: (ctx) => {
		const native: GenericActionCtx<Model> = ctx.native
		void native
		// @ts-expect-error systems have no role
		void ctx.role
		return null
	},
})
// @ts-expect-error role inference preserves the configured vocabulary
functions.roleMutation('admin')
const transformed = functions.authQuery({
	args: { value: z.string().transform(Number) },
	returns: z.number().transform((value) => ({ value })),
	handler: (ctx, args) => {
		const parsed: number = args.value
		void ctx.actorLabel
		return Effect.succeed(parsed)
	},
})
type Api = ApiFromModules<{ notes: { transformed: typeof transformed } }>
const raw: FunctionArgs<Api['notes']['transformed']> = { value: '42' }
const result: FunctionReturnType<Api['notes']['transformed']> = { value: 42 }
void raw
void result
// @ts-expect-error missing services remain rejected at the shared boundary
functions.authQuery({
	args: {},
	handler: () =>
		Effect.gen(function* () {
			return yield* Missing
		}),
})
createEffectAuthFunctions(config, {
	query: {
		context: () =>
			Effect.gen(function* () {
				const value = yield* Missing
				return { value }
			}),
	},
	mutation: {},
	action: {},
	systemQuery: {},
	systemMutation: {},
	systemAction: {},
})
	// @ts-expect-error initialized Effects must have their services provided
	.authQuery({ args: {}, handler: () => null })
createEffectAuthFunctions(config, {
	// @ts-expect-error additions cannot overwrite trusted actor
	query: { context: () => ({ actor: 'forged' }) },
	mutation: {},
	action: {},
	systemQuery: {},
	systemMutation: {},
	systemAction: {},
})
