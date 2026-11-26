import { NoOp } from 'convex-helpers/server/customFunctions'
import {
	actionGeneric,
	defineSchema,
	defineTable,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	mutationGeneric,
	queryGeneric,
	type ApiFromModules,
	type DataModelFromSchemaDefinition,
	type FunctionArgs,
	type FunctionReturnType,
	type GenericActionCtx,
	type GenericQueryCtx,
	type RegisteredMutation,
	type RegisteredQuery,
} from 'convex/server'
import { v, type GenericId } from 'convex/values'
import { createAuthFunctions, type AuthBundle, type Include } from '../src/auth'
import { k } from '../src/k'
import { kCustomMutation, kCustomQuery } from '../src/registration'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
type ArgsOf<F> = F extends RegisteredQuery<any, infer A, any> ? A : never
type MutationArgsOf<F> = F extends RegisteredMutation<any, infer A, any> ? A : never
type ReturnsOf<F> = F extends RegisteredQuery<any, any, infer R> ? R : never

const query = kCustomQuery(queryGeneric, NoOp)

// Field object: the handler sees the output side, callers the input side.
const fields = query({
	args: {
		name: k.string().trim(),
		count: k.number().default(1),
		size: k.string().transform(Number),
	},
	handler: (_ctx, args) => {
		const output: Assert<Equal<typeof args, { name: string; count: number; size: number }>> = true
		void output
		return args.count
	},
})

// k.object: the same split.
const object = query({
	args: k.object({ count: k.number().default(1), tags: k.array(k.string()).optional() }),
	handler: (_ctx, args) => {
		const output: Assert<Equal<typeof args, { count: number; tags?: string[] }>> = true
		void output
		return null
	},
})

// A type-guard refine narrows args inside containers, for callers and the handler alike.
type Slug = 'owner' | 'viewer'
const slug = k.string().refine((value): value is Slug => value === 'owner' || value === 'viewer')
const guarded = query({
	args: k.object({ role: slug, roles: k.array(slug), maybe: slug.optional() }),
	handler: (_ctx, args) => {
		const output: Assert<Equal<typeof args, { role: Slug; roles: Slug[]; maybe?: Slug }>> = true
		void output
		return null
	},
})
const guardedArgs: Assert<
	Equal<ArgsOf<typeof guarded>, { role: Slug; roles: Slug[]; maybe?: Slug }>
> = true
void guardedArgs

// Native args infer exactly as plain Convex.
const native = query({
	args: { id: v.id('documents'), at: v.optional(v.number()) },
	handler: (_ctx, args) => {
		const output: Assert<Equal<typeof args, { id: GenericId<'documents'>; at?: number }>> = true
		void output
		return null
	},
})
const plain = queryGeneric({
	args: { id: v.id('documents'), at: v.optional(v.number()) },
	handler: () => null,
})

// A mix of k and native fields.
const mixed = query({
	args: { name: k.string().default('x'), raw: v.string() },
	handler: (_ctx, args) => {
		const output: Assert<Equal<typeof args, { name: string; raw: string }>> = true
		void output
		return null
	},
})

// Customization args merge into the caller's args; made args into the handler's.
const custom = kCustomMutation(mutationGeneric, {
	args: { token: v.string() },
	input: (_ctx, args) => ({ ctx: { who: args.token }, args: { added: true } }),
})({
	args: { name: k.string() },
	handler: (ctx, args) => {
		const output: Assert<Equal<typeof args, { name: string; added: boolean }>> = true
		const who: string = ctx.who
		void output
		void who
		return null
	},
})

// `returns` constrains the handler result.
const returned = query({
	returns: k.object({ count: k.number().default(0) }),
	handler: () => ({ count: 1 }),
})
query({
	returns: k.number(),
	// @ts-expect-error the handler must return the declared output
	handler: () => 'text',
})
query({
	returns: v.string(),
	// @ts-expect-error native returns constrain the handler too
	handler: () => 1,
})

const assertions: [
	Assert<Equal<ArgsOf<typeof fields>, { name: string; count?: number; size: string }>>,
	Assert<Equal<ArgsOf<typeof object>, { count?: number; tags?: string[] }>>,
	Assert<Equal<ArgsOf<typeof native>, ArgsOf<typeof plain>>>,
	Assert<Equal<ArgsOf<typeof mixed>, { name?: string; raw: string }>>,
	Assert<Equal<MutationArgsOf<typeof custom>, { name: string; token: string }>>,
	Assert<Equal<ReturnsOf<typeof returned>, { count: number }>>,
] = [true, true, true, true, true, true]
void assertions

// Carried over from the v1 registration type suite: auth contexts, client/handler sides, customization.
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
const authArgs = k.object({
	id: k.id('tasks'),
	text: k.string().transform((s) => s.length),
	count: k.number().default(7),
	optional: k.string().optional(),
})
const authQuery = auth.authQuery({
	args: authArgs,
	returns: k.number(),
	handler: (ctx, args) => {
		const output: Assert<
			Equal<typeof args, { id: GenericId<'tasks'>; text: number; count: number; optional?: string }>
		> = true
		const nativeCtx: GenericQueryCtx<Model> = ctx
		const bundle: AuthBundle<'owner' | 'viewer'> = ctx
		const include: Include = ctx.include
		void [output, nativeCtx, bundle, include]
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
const authAction = auth.authAction({
	args: authArgs.shape,
	handler: (ctx, args) => {
		const nativeCtx: GenericActionCtx<Model> = ctx
		void nativeCtx
		// @ts-expect-error actions do not have a database
		void ctx.db
		return args.text
	},
})
const systemQuery = auth.systemQuery({
	args: authArgs,
	returns: k.id('tasks'),
	handler: (_ctx, args) => args.id,
})
declare const api: ApiFromModules<{
	functions: { query: typeof authQuery; action: typeof authAction; system: typeof systemQuery }
}>
declare const taskId: GenericId<'tasks'>
const clientArgs: FunctionArgs<typeof api.functions.query> = { id: taskId, text: 'raw' }
// @ts-expect-error clients send transform input, not handler output
const wrongClient: FunctionArgs<typeof api.functions.query> = { id: taskId, text: 4 }
void [clientArgs, wrongClient]

const customQuery = kCustomQuery(queryGeneric, {
	args: { token: v.id('sessions') },
	input: (_ctx, args, extra: { label: string }) => {
		const token: GenericId<'sessions'> = args.token
		void [token, extra.label]
		return { ctx: { auth: 'replacement' as const }, args: { made: true as const } }
	},
})
const customized = customQuery({
	label: 'label',
	args: { text: k.string().transform((s) => s.length) },
	handler: (ctx, args) => {
		const output: Assert<Equal<typeof args, { text: number; made: true }>> = true
		const replaced: Assert<Equal<typeof ctx.auth, 'replacement'>> = true
		void [output, replaced]
		// @ts-expect-error consumed customization fields are absent from user args
		void args.token
		return args.text
	},
})
// @ts-expect-error customization extra definition fields remain required
customQuery({ args: {}, handler: () => 1 })

const dataDeclared = query({
	args: authArgs,
	returns: k.number(),
	handler: (_ctx, parsed) => parsed.text,
})
const getterDeclared = query({
	get args() {
		return authArgs
	},
	get returns() {
		return k.number()
	},
	handler: (_ctx, parsed) => parsed.text,
})

const carried: [
	Assert<
		Equal<
			FunctionArgs<typeof api.functions.query>,
			{ id: GenericId<'tasks'>; text: string; count?: number; optional?: string }
		>
	>,
	Assert<Equal<FunctionReturnType<typeof api.functions.query>, number>>,
	Assert<Equal<FunctionReturnType<typeof api.functions.action>, number>>,
	Assert<Equal<FunctionReturnType<typeof api.functions.system>, GenericId<'tasks'>>>,
	Assert<Equal<(typeof api.functions.query)['_visibility'], 'public'>>,
	Assert<Equal<(typeof api.functions.system)['_visibility'], 'internal'>>,
	Assert<Equal<MutationArgsOf<typeof custom>, { name: string; token: string }>>,
	Assert<Equal<ArgsOf<typeof customized>, { text: string; token: GenericId<'sessions'> }>>,
	Assert<Equal<typeof getterDeclared, typeof dataDeclared>>,
] = [true, true, true, true, true, true, true, true, true]
void carried
