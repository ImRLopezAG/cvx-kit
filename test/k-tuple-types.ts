import type { GenericId } from 'convex/values'
import { k, type KNever, type KTuple } from '../src/k'
import { kTable } from '../src/table'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
const pair = k.tuple([k.literal('x'), k.number()])
const rest = pair.rest(k.boolean())
const nested = k.tuple([k.object({ n: k.number().default(1) }), k.tuple([k.id('users')])])
const transformed = k.tuple([k.string().transform(Number)]).rest(k.boolean())
const nestedObject = k.object({ nested })
const withDefault = k.object({ pair: pair.default(['x', 1]) })
const assertions: [
	Assert<
		Equal<
			typeof nestedObject.outputValidator.type,
			{ nested: [{ n: number }, [GenericId<'users'>]] }
		>
	>,
	Assert<Equal<k.input<typeof pair>, ['x', number]>>,
	Assert<Equal<k.infer<typeof pair>, ['x', number]>>,
	Assert<Equal<k.infer<typeof rest>, ['x', number, ...boolean[]]>>,
	Assert<Equal<k.input<typeof nested>, [{ n?: number }, [GenericId<'users'>]]>>,
	Assert<Equal<k.infer<typeof nested>, [{ n: number }, [GenericId<'users'>]]>>,
	Assert<Equal<k.input<typeof transformed>, [string, ...boolean[]]>>,
	Assert<Equal<k.output<typeof transformed>, [number, ...boolean[]]>>,
	Assert<Equal<typeof transformed._t, true>>,
	Assert<Equal<k.input<typeof withDefault>, { pair?: ['x', number] }>>,
	Assert<Equal<k.output<typeof withDefault>, { pair: ['x', number] }>>,
	Assert<Equal<k.infer<KNever>, never>>,
	Assert<Equal<k.infer<ReturnType<typeof k.tuple<[]>>>, []>>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true]
void assertions
const long = k.tuple([
	k.string(),
	k.number(),
	k.boolean(),
	k.string(),
	k.number(),
	k.boolean(),
	k.string(),
	k.number(),
	k.boolean(),
	k.object({ nested: k.object({ label: k.string() }) }),
	k.string(),
	k.number(),
	k.boolean(),
	k.string(),
	k.number(),
	k.boolean(),
	k.string(),
	k.number(),
	k.boolean(),
	k.string(),
	k.number(),
	k.boolean(),
	k.string(),
	k.number(),
	k.boolean(),
	k.string(),
	k.number(),
	k.boolean(),
	k.string(),
	k.number(),
	k.boolean(),
	k.string(),
	k.number(),
])
const typed: KTuple<[ReturnType<typeof k.string>]> = k.tuple([k.string()])
void typed
void long.validator
// @ts-expect-error positional input retains its literal and ordered members
const wrong: k.input<typeof pair> = [1, 'x']
void wrong
// @ts-expect-error wrapping a tuple hides rest
pair.optional().rest(k.string())
// @ts-expect-error foreign children require kit schemas
k.tuple([{}])
// @ts-expect-error tuple transforms cannot enter table fields
kTable('badTuple', { transformed })
