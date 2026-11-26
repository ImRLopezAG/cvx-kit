import { defineSchema, defineTable } from 'convex/server'
import type {
	GenericId,
	VArray,
	VFloat64,
	VId,
	VLiteral,
	VNull,
	VObject,
	VString,
	VUnion,
} from 'convex/values'
import { k } from '../src/k/index'
import type { NativeOf } from '../src/k/types'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

const task = k.object({
	title: k.string().trim().min(1),
	note: k.string().optional(),
	status: k.enum(['open', 'done']).default('open'),
	owner: k.id('users'),
	meta: k.object({ priority: k.number().int(), labels: k.array(k.string()) }),
	archivedAt: k.number().nullable(),
})

type Output = {
	title: string
	note?: string
	status: 'open' | 'done'
	owner: GenericId<'users'>
	meta: { priority: number; labels: string[] }
	archivedAt: number | null
}
type Input = {
	title: string
	note?: string
	status?: 'open' | 'done'
	owner: GenericId<'users'>
	meta: { priority: number; labels: string[] }
	archivedAt: number | null
}

const assertions: [
	Assert<Equal<k.infer<typeof task>, Output>>,
	Assert<Equal<k.output<typeof task>, Output>>,
	Assert<Equal<k.input<typeof task>, Input>>,
	Assert<Equal<k.infer<ReturnType<typeof k.enum<['a', 'b']>>>, 'a' | 'b'>>,
	Assert<Equal<k.infer<ReturnType<typeof k.id<'users'>>>, GenericId<'users'>>>,
	Assert<Equal<typeof task.validator.type, Input>>,
	Assert<Equal<NativeOf<ReturnType<typeof k.string>>, VString<string, 'required'>>>,
	Assert<Equal<typeof task.validator.fields.title, VString<string, 'required'>>>,
	Assert<Equal<typeof task.validator.fields.note, VString<string | undefined, 'optional'>>>,
	Assert<
		Equal<
			typeof task.validator.fields.status,
			VUnion<'open' | 'done' | undefined, [VLiteral<'open'>, VLiteral<'done'>], 'optional', never>
		>
	>,
	Assert<Equal<typeof task.validator.fields.owner, VId<GenericId<'users'>, 'required'>>>,
	Assert<
		Equal<
			typeof task.validator.fields.archivedAt,
			VUnion<number | null, [VFloat64<number>, VNull<null>], 'required', never>
		>
	>,
	Assert<
		Equal<
			typeof task.validator.fields.meta.fields.labels,
			VArray<string[], VString<string>, 'required'>
		>
	>,
	Assert<Equal<typeof task.validator.fieldPaths, TaskPaths>>,
	Assert<Equal<k.infer<ReturnType<typeof k.literal<'x'>>>, 'x'>>,
	Assert<Equal<NativeOf<ReturnType<typeof k.enum<['only']>>>, VLiteral<'only', 'required'>>>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true]
void assertions

type TaskPaths =
	| 'title'
	| 'note'
	| 'status'
	| 'owner'
	| 'meta'
	| 'meta.priority'
	| 'meta.labels'
	| 'archivedAt'

const union = k.union([k.object({ kind: k.literal('a') }), k.string()])
const unionAssertions: [
	Assert<Equal<k.infer<typeof union>, { kind: 'a' } | string>>,
	Assert<
		Equal<VObject<{ kind: 'a' }, { kind: VLiteral<'a'> }>, (typeof union.validator.members)[0]>
	>,
	Assert<Equal<k.infer<ReturnType<typeof task.refine>>, Output>>,
] = [true, true, true]
void unionAssertions

const optionalNullable = k.string().optional().nullable()
const nullableOptional = k.string().nullable().optional()
const nested = k.object({
	inner: k.object({ n: k.number().default(0) }),
	list: k.array(k.boolean()),
})
type NullableString = VUnion<
	string | null | undefined,
	[VString<string>, VNull<null>],
	'optional',
	never
>
const wrapperAssertions: [
	Assert<Equal<typeof optionalNullable.validator, NullableString>>,
	Assert<Equal<typeof nullableOptional.validator, NullableString>>,
	Assert<Equal<k.infer<typeof optionalNullable>, string | null | undefined>>,
	Assert<Equal<k.input<typeof optionalNullable>, string | null | undefined>>,
	Assert<Equal<k.infer<typeof nested>, { inner: { n: number }; list: boolean[] }>>,
	Assert<Equal<k.input<typeof nested>, { inner: { n?: number }; list: boolean[] }>>,
] = [true, true, true, true, true, true]
void wrapperAssertions

const tasks = defineTable(task.validator)
	.index('by_owner', ['owner'])
	.index('by_priority', ['meta.priority'])
// @ts-expect-error unknown nested field path
tasks.index('by_missing', ['meta.missing'])
const schema = defineSchema({ tasks })
void schema

// @ts-expect-error min is not available once a schema is wrapped by optional
k.string().optional().min(1)
// @ts-expect-error a default must match the output type
k.number().default('x')
