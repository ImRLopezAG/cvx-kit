import { defineTable } from 'convex/server'
import type {
	GenericId,
	JSONValue,
	VAny,
	VBytes,
	VFloat64,
	VInt64,
	VLiteral,
	VObject,
	VOptional,
	VRecord,
	VString,
	VUnion,
} from 'convex/values'
import { k } from '../src/k'
import type { KString, NativeOf, OutputNativeOf } from '../src/k'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

const figure = k.discriminatedUnion('kind', [
	k.object({ kind: k.literal('circle'), radius: k.number() }),
	k.object({ kind: k.literal('square'), side: k.number() }),
])
const ratings = k.record(k.id('users'), k.number())
const labels = k.record(k.string(), k.string())
const task = k.object({
	title: k.string().min(1),
	owner: k.object({ id: k.id('users'), name: k.string() }),
	status: k.enum(['open', 'done']).default('open'),
	payload: k.json(),
	blob: k.bytes(),
	count: k.int64(),
	extra: k.any().optional(),
})

const kindAssertions: [
	Assert<
		Equal<
			k.infer<typeof figure>,
			{ kind: 'circle'; radius: number } | { kind: 'square'; side: number }
		>
	>,
	Assert<Equal<k.infer<typeof ratings>, Record<GenericId<'users'>, number>>>,
	Assert<
		Equal<
			typeof labels.validator,
			VRecord<Record<string, string>, VString<string>, VString<string>>
		>
	>,
	Assert<Equal<k.infer<typeof task>['payload'], JSONValue>>,
	Assert<Equal<k.infer<typeof task>['blob'], ArrayBuffer>>,
	Assert<Equal<k.infer<typeof task>['count'], bigint>>,
	Assert<Equal<typeof task.validator.fields.count, VInt64<bigint>>>,
	Assert<Equal<typeof task.validator.fields.blob, VBytes<ArrayBuffer>>>,
	Assert<Equal<typeof task.validator.fields.payload, VAny<JSONValue>>>,
	Assert<Equal<typeof task.validator.fields.extra, VAny<any, 'optional'>>>,
	Assert<Equal<(typeof figure.validator.members)[1]['fields']['side'], VFloat64<number>>>,
	Assert<Equal<typeof figure.discriminator, 'kind'>>,
	Assert<Equal<ReturnType<typeof k.enum<['a', 'b']>>['options'], ['a', 'b']>>,
	Assert<Equal<(typeof task)['shape']['title'], KString>>,
	Assert<Equal<ReturnType<(typeof task)['shape']['title']['optional']>['unwrap'], () => KString>>,
	Assert<Equal<NativeOf<(typeof task)['shape']['title']>, VString<string>>>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true]
void kindAssertions

const partial = task.pick('title', 'status').partial()
const omitted = task.omit('payload', 'blob', 'count', 'extra')
const extended = task.pick('title').extend({ title: k.number(), size: k.int() })
const objectAssertions: [
	Assert<Equal<k.input<typeof partial>, { title?: string; status?: 'open' | 'done' }>>,
	Assert<Equal<k.output<typeof partial>, { title?: string; status?: 'open' | 'done' }>>,
	Assert<Equal<keyof k.infer<typeof omitted>, 'title' | 'owner' | 'status'>>,
	Assert<Equal<k.infer<typeof extended>, { title: number; size: number }>>,
	Assert<Equal<typeof partial.validator.fields.title, VString<string | undefined, 'optional'>>>,
] = [true, true, true, true, true]
void objectAssertions

type OutputStatus = VUnion<'open' | 'done', [VLiteral<'open'>, VLiteral<'done'>], 'required', never>
const outputAssertions: [
	Assert<Equal<typeof task.outputValidator.fields.status, OutputStatus>>,
	Assert<Equal<typeof task.validator.fields.status, VOptional<OutputStatus>>>,
	Assert<Equal<typeof task.outputValidator.type, k.output<typeof task>>>,
	Assert<Equal<OutputNativeOf<typeof labels>, typeof labels.validator>>,
	Assert<Equal<typeof omitted.outputValidator.fields.title, VString<string>>>,
	Assert<
		Equal<
			typeof task.outputValidator,
			VObject<k.output<typeof task>, (typeof task.outputValidator)['fields']>
		>
	>,
] = [true, true, true, true, true, true]
void outputAssertions

const table = defineTable(task.validator).index('by_owner', ['owner.id', 'status'])
// @ts-expect-error unknown nested field path
table.index('by_missing', ['owner.missing'])
void table
