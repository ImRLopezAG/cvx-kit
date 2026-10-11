import {
	zCustomQuery as helperQuery,
	zCustomMutation as helperMutation,
	zCustomAction as helperAction,
	zid,
} from 'convex-helpers/server/zod4'
import { NoOp } from 'convex-helpers/server/customFunctions'
import {
	queryGeneric,
	mutationGeneric,
	actionGeneric,
	internalQueryGeneric,
	internalMutationGeneric,
	internalActionGeneric,
	defineSchema,
	defineTable,
	type ApiFromModules,
	type FunctionArgs,
	type FunctionReturnType,
	type DataModelFromSchemaDefinition,
	type GenericQueryCtx,
	type GenericMutationCtx,
	type GenericActionCtx,
} from 'convex/server'
import { v, type GenericId } from 'convex/values'
import { z } from 'zod'
import * as mini from 'zod/mini'
import { zCustomQuery, zCustomMutation, zCustomAction } from '../src/zod-registration'
import { createAuthFunctions, type AuthFunctions, type AuthBundle, type Include } from '../src/auth'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
function exact<T extends true>(..._proof: T extends true ? [] : [never]) {}
exact<Equal<typeof zCustomQuery, typeof helperQuery>>()
exact<Equal<typeof zCustomMutation, typeof helperMutation>>()
exact<Equal<typeof zCustomAction, typeof helperAction>>()

const schema = defineSchema({ tasks: defineTable({ title: v.string() }) })
type Model = DataModelFromSchemaDefinition<typeof schema>
const auth = createAuthFunctions<Model, 'owner' | 'viewer'>({
	query: queryGeneric,
	mutation: mutationGeneric,
	action: actionGeneric,
	internalQuery: internalQueryGeneric,
	internalMutation: internalMutationGeneric,
	internalAction: internalActionGeneric,
	getAuthUser: async () => ({ id: 'user' }),
	mapRole: () => 'owner',
	adminRoles: ['owner'],
})
exact<Equal<typeof auth, AuthFunctions<Model, 'owner' | 'viewer'>>>()

const args = z.object({
	id: zid('tasks'),
	text: z.string().transform((s) => s.length),
	count: z.number().default(7),
	optional: z.string().optional(),
})
const returns = z.number().transform((n) => `${n}`)
const query = auth.authQuery({
	args,
	returns,
	handler: (ctx, args) => {
		exact<
			Equal<typeof args, { id: GenericId<'tasks'>; text: number; count: number; optional?: string }>
		>()
		const native: GenericQueryCtx<Model> = ctx
		const bundle: AuthBundle<'owner' | 'viewer'> = ctx
		const include: Include = ctx.include
		void [native, bundle, include]
		// @ts-expect-error native ID brands retain table identity in the handler
		const wrongId: GenericId<'other'> = args.id
		// @ts-expect-error input transforms have already run for handlers
		const raw: string = args.text
		// @ts-expect-error queries have no scheduler
		void ctx.scheduler
		void [wrongId, raw]
		return args.text
	},
})
const mutation = auth.authMutation({
	args: args.shape,
	returns,
	handler: (ctx, args) => {
		const native: GenericMutationCtx<Model> = ctx
		const id: GenericId<'tasks'> = args.id
		void [native, id]
		return args.text
	},
})
const action = auth.authAction({
	args,
	returns,
	handler: (ctx, args) => {
		const native: GenericActionCtx<Model> = ctx
		void native
		// @ts-expect-error actions do not have a database
		void ctx.db
		return args.text
	},
})
const system = auth.systemQuery({
	args,
	returns: zid('tasks'),
	handler: (ctx, args) => {
		const native: GenericQueryCtx<Model> = ctx
		void native
		// @ts-expect-error system contexts have no auth bundle
		void ctx.actor
		return args.id
	},
})
declare const api: ApiFromModules<{
	functions: {
		query: typeof query
		mutation: typeof mutation
		action: typeof action
		system: typeof system
	}
}>
exact<
	Equal<
		FunctionArgs<typeof api.functions.query>,
		{ id: string; text: string; count?: number; optional?: string }
	>
>()
exact<Equal<FunctionReturnType<typeof api.functions.query>, string>>()
exact<Equal<FunctionReturnType<typeof api.functions.mutation>, string>>()
exact<Equal<FunctionReturnType<typeof api.functions.action>, string>>()
exact<Equal<FunctionReturnType<typeof api.functions.system>, GenericId<'tasks'>>>()
exact<Equal<(typeof api.functions.query)['_visibility'], 'public'>>()
exact<Equal<(typeof api.functions.system)['_visibility'], 'internal'>>()
const clientArgs: FunctionArgs<typeof api.functions.query> = { id: 'native-id', text: 'raw' }
// @ts-expect-error clients send transform input, not handler output
const wrongClient: FunctionArgs<typeof api.functions.query> = { id: 'native-id', text: 4 }
// @ts-expect-error return parser's input type constrains handler return
auth.authQuery({ args: {}, returns, handler: () => 'wrong input' })
// @ts-expect-error only object schemas or field maps are accepted for args
auth.authQuery({ args: z.string(), handler: () => null })
// @ts-expect-error only declared application roles are admitted
auth.roleQuery('admin')
void [clientArgs, wrongClient]

for (const builder of [auth.roleQuery('owner'), auth.adminQuery]) {
	builder({
		args,
		returns,
		handler: (ctx, args) => {
			const role: 'owner' | 'viewer' = ctx.role
			void role
			return args.text
		},
	})
}
for (const builder of [auth.roleMutation('owner'), auth.adminMutation]) {
	builder({
		args,
		handler: (ctx, args) => {
			const native: GenericMutationCtx<Model> = ctx
			void native
			return args.id
		},
	})
}
for (const builder of [auth.roleAction('owner'), auth.adminAction]) {
	builder({
		args,
		handler: (ctx, args) => {
			const native: GenericActionCtx<Model> = ctx
			void native
			return args.text
		},
	})
}

const custom = zCustomQuery(queryGeneric, {
	args: { token: v.id('sessions') },
	input: (_ctx, args, extra: { label: string }) => {
		const token: GenericId<'sessions'> = args.token
		void [token, extra.label]
		return { ctx: { auth: 'replacement' as const }, args: { made: true as const } }
	},
})
const customized = custom({
	label: 'label',
	args: { text: z.string().transform((s) => s.length) },
	returns,
	handler: (ctx, args) => {
		exact<Equal<typeof ctx.auth, 'replacement'>>()
		exact<Equal<typeof args, { text: number; made: true }>>()
		// @ts-expect-error consumed customization fields are absent from user args
		void args.token
		return args.text
	},
})
// @ts-expect-error customization extra definition fields remain required
custom({ args: {}, handler: () => 1 })
declare const customApi: ApiFromModules<{ functions: { customized: typeof customized } }>
exact<
	Equal<
		FunctionArgs<typeof customApi.functions.customized>,
		{ text: string; token: GenericId<'sessions'> }
	>
>()
exact<Equal<FunctionReturnType<typeof customApi.functions.customized>, string>>()

const miniArgs = mini.object({ value: mini.string(), optional: mini.optional(mini.number()) })
// Mini input/output follows the helper's existing core-object contract.
const miniFn = zCustomQuery(
	queryGeneric,
	NoOp,
)({
	args: miniArgs,
	handler: (_, parsed) => {
		exact<Equal<typeof parsed, { value: string; optional?: number }>>()
		return parsed.value
	},
})
const oldMiniFn = helperQuery(
	queryGeneric,
	NoOp,
)({ args: miniArgs, handler: (_, parsed) => parsed.value })
exact<Equal<typeof miniFn, typeof oldMiniFn>>()

const shorthand = zCustomQuery(queryGeneric, NoOp)(() => 'shorthand')
const oldShorthand = helperQuery(queryGeneric, NoOp)(() => 'shorthand')
exact<Equal<typeof shorthand, typeof oldShorthand>>()
const noArgs = zCustomQuery(queryGeneric, NoOp)({ handler: () => null })
const oldNoArgs = helperQuery(queryGeneric, NoOp)({ handler: () => null })
exact<Equal<typeof noArgs, typeof oldNoArgs>>()

auth.systemMutation({
	args,
	handler: (ctx, args) => {
		const native: GenericMutationCtx<Model> = ctx
		void native
		return args.id
	},
})
auth.systemAction({
	args,
	handler: (ctx, args) => {
		const native: GenericActionCtx<Model> = ctx
		void native
		return args.text
	},
})
