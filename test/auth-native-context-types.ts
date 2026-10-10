import {
	actionGeneric,
	defineSchema,
	defineTable,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	mutationGeneric,
	queryGeneric,
	type DataModelFromSchemaDefinition,
	type GenericActionCtx,
	type GenericMutationCtx,
	type GenericQueryCtx,
} from 'convex/server'
import { v } from 'convex/values'
import { z } from 'zod'
import { Context } from 'effect'
import { createAuthFunctions, type AuthBundle, type Include } from 'cvx-kit/auth'
import { createEffectFoundation, effectZodApiBuilder } from 'cvx-kit/effect'

const schema = defineSchema({ notes: defineTable({ title: v.string() }) })
type Model = DataModelFromSchemaDefinition<typeof schema>
type Role = 'owner' | 'viewer'
const auth = createAuthFunctions<Model, Role>({
	query: queryGeneric,
	mutation: mutationGeneric,
	action: actionGeneric,
	internalQuery: internalQueryGeneric,
	internalMutation: internalMutationGeneric,
	internalAction: internalActionGeneric,
	getAuthUser: async () => ({ id: 'user' }),
	mapRole: (slug) => (slug === 'owner' || slug === 'viewer' ? slug : null),
	adminRoles: ['owner'],
})
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
function queryContext(ctx: GenericQueryCtx<Model>) {
	return ctx
}
function mutationContext(ctx: GenericMutationCtx<Model>) {
	return ctx
}
function actionContext(ctx: GenericActionCtx<Model>) {
	return ctx
}

for (const builder of [auth.authQuery, auth.roleQuery('owner'), auth.adminQuery]) {
	builder({
		args: {},
		handler: (ctx) => {
			queryContext(ctx)
			queries.withContext(ctx)
			// @ts-expect-error query contexts cannot bind mutation commands
			commands.withContext(ctx)
			const role: Role = ctx.role
			const include: Include = ctx.include
			const title: Promise<string | undefined> = ctx
				.include(ctx.db.query('notes'))
				.execute(1, (rows) => rows[0]?.title)
			void role
			void include
			void title
			return null
		},
	})
}
for (const builder of [auth.authMutation, auth.roleMutation('owner'), auth.adminMutation]) {
	builder({
		args: {},
		handler: (ctx) => {
			mutationContext(ctx)
			commands.withContext(ctx)
			queries.withContext(ctx)
			const role: Role = ctx.actor.role
			const include: Include = ctx.include
			void role
			void include
			return null
		},
	})
}
for (const builder of [auth.authAction, auth.roleAction('owner'), auth.adminAction]) {
	builder({
		args: {},
		handler: (ctx) => {
			actionContext(ctx)
			const role: Role = ctx.org.role
			void role
			// @ts-expect-error actions do not have include
			void ctx.include
			return null
		},
	})
}
auth.systemQuery({
	args: {},
	handler: (ctx) => {
		queryContext(ctx)
		const include: Include = ctx.include
		void include
		// @ts-expect-error trusted system contexts do not carry authentication fields
		void ctx.actor
		return null
	},
})
auth.systemMutation({
	args: {},
	handler: (ctx) => {
		mutationContext(ctx)
		const include: Include = ctx.include
		void include
		// @ts-expect-error trusted system contexts do not carry authentication fields
		void ctx.role
		return null
	},
})
auth.systemAction({
	args: {},
	handler: (ctx) => {
		actionContext(ctx)
		// @ts-expect-error actions do not have include
		void ctx.include
		// @ts-expect-error trusted system contexts do not carry authentication fields
		void ctx.user
		return null
	},
})
declare const nativeQuery: GenericQueryCtx<Model>
const bundle: Promise<AuthBundle<Role>> = auth.authenticatedUser(nativeQuery)
void bundle
// @ts-expect-error role gates accept only the application's vocabulary
auth.roleQuery('admin')

// The Effect adapter must accept symbolic native interfaces without losing fields.
effectZodApiBuilder(auth.authMutation, { services: () => Context.empty() })({
	args: {},
	handler: (ctx) => {
		mutationContext(ctx)
		commands.withContext(ctx)
		const role: Role = ctx.role
		void role
		return null
	},
})
