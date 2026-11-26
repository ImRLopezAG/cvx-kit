import { NoOp } from 'convex-helpers/server/customFunctions'
import {
	mutationGeneric,
	queryGeneric,
	type RegisteredMutation,
	type RegisteredQuery,
} from 'convex/server'
import { v, type GenericId } from 'convex/values'
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
	args: { name: k.string().trim(), count: k.number().default(1), size: k.string().transform(Number) },
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

// Native args infer exactly as plain Convex.
const native = query({
	args: { id: v.id('documents'), at: v.optional(v.number()) },
	handler: (_ctx, args) => {
		const output: Assert<
			Equal<typeof args, { id: GenericId<'documents'>; at?: number }>
		> = true
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
