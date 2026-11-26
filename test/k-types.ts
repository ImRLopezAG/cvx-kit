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
	Assert<Equal<(typeof task.validator.fields.payload)['type'], JSONValue>>,
	Assert<Equal<(typeof task.validator.fields.payload)['members']['length'], 6>>,
	Assert<Equal<typeof task.validator.fields.extra, VAny<any, 'optional'>>>,
	Assert<Equal<(typeof figure.validator.members)[1]['fields']['side'], VFloat64<number>>>,
	Assert<Equal<typeof figure.discriminator, 'kind'>>,
	Assert<Equal<ReturnType<typeof k.enum<['a', 'b']>>['options'], ['a', 'b']>>,
	Assert<Equal<(typeof task)['shape']['title'], KString>>,
	Assert<Equal<ReturnType<(typeof task)['shape']['title']['optional']>['unwrap'], () => KString>>,
	Assert<Equal<NativeOf<(typeof task)['shape']['title']>, VString<string>>>,
] = [
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
]
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

const anyBesideDefault = k.object({
	a: k.any(),
	j: k.json(),
	o: k.any().optional(),
	oj: k.json().optional(),
	d: k.any().default(1),
	n: k.number().default(3),
})
const anyWithoutDefault = k.object({ a: k.any(), j: k.json(), o: k.any().optional() })

const anyFieldAssertions: [
	Assert<
		Equal<
			k.output<typeof anyBesideDefault>,
			{ a: any; j: JSONValue; d: any; n: number; o?: any; oj?: JSONValue }
		>
	>,
	Assert<Equal<k.infer<typeof anyBesideDefault>, k.output<typeof anyBesideDefault>>>,
	Assert<
		Equal<
			k.input<typeof anyBesideDefault>,
			{ a: any; j: JSONValue; o?: any; oj?: JSONValue; d?: any; n?: number }
		>
	>,
	Assert<Equal<k.output<typeof anyWithoutDefault>, { a: any; j: JSONValue; o?: any }>>,
	Assert<Equal<k.input<typeof anyWithoutDefault>, { a: any; j: JSONValue; o?: any }>>,
] = [true, true, true, true, true]
void anyFieldAssertions

type TimeOfDay = `${number}:${number}`
function isTimeOfDay(value: string): value is TimeOfDay {
	return /^\d{2}:\d{2}$/.test(value)
}
const timeOfDay = k.string().refine(isTimeOfDay, 'Expected HH:MM')
const optionalTime = k.string().min(5).refine(isTimeOfDay).max(5).optional()
const optionalGuard = k
	.string()
	.optional()
	.refine((value): value is TimeOfDay | undefined => value === undefined || isTimeOfDay(value))
const nullableGuard = k
	.string()
	.nullable()
	.refine((value): value is TimeOfDay | null => value === null || isTimeOfDay(value))
const plainRefine = k.string().refine((value) => value.length > 0)
const transformedGuard = k
	.string()
	.transform((value) => value.length)
	.refine((value): value is 1 => value === 1)
const inObject = k.object({ at: timeOfDay, maybe: optionalGuard, empty: nullableGuard })
const nullableTime = nullableGuard
const parsedTime = timeOfDay.parse('09:30')

const refineAssertions: [
	Assert<Equal<k.output<typeof timeOfDay>, TimeOfDay>>,
	Assert<Equal<k.input<typeof timeOfDay>, TimeOfDay>>,
	Assert<Equal<typeof parsedTime, TimeOfDay>>,
	Assert<
		Equal<k.input<typeof inObject>, { at: TimeOfDay; maybe?: TimeOfDay; empty: TimeOfDay | null }>
	>,
	Assert<Equal<k.output<typeof nullableTime>, TimeOfDay | null>>,
	Assert<Equal<k.input<typeof nullableTime>, TimeOfDay | null>>,
	Assert<Equal<k.output<typeof optionalTime>, TimeOfDay | undefined>>,
	Assert<Equal<k.output<typeof plainRefine>, string>>,
	Assert<Equal<typeof plainRefine, KString>>,
	Assert<Equal<k.output<typeof transformedGuard>, 1>>,
	Assert<Equal<k.input<typeof transformedGuard>, string>>,
	Assert<
		Equal<k.output<typeof inObject>, { at: TimeOfDay; maybe?: TimeOfDay; empty: TimeOfDay | null }>
	>,
	Assert<Equal<k.output<ReturnType<typeof timeOfDay.nullable>>, TimeOfDay | null>>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true]
void refineAssertions

const zodParityObject = k.object({ a: k.string(), b: k.number().optional(), c: k.id('users') })
const zodParityStatus = k.enum(['open', 'done', 'archived'])
const zodParityAssertions: [
	Assert<Equal<k.output<typeof objectKeys>, 'a' | 'b' | 'c'>>,
	Assert<Equal<k.output<typeof requiredAll>, { a: string; b: number; c: GenericId<'users'> }>>,
	Assert<Equal<k.output<typeof requiredSome>, { a: string; b?: number; c?: GenericId<'users'> }>>,
	Assert<
		Equal<k.output<ReturnType<typeof zodParityStatus.exclude<['archived']>>>, 'open' | 'done'>
	>,
	Assert<Equal<k.output<typeof extracted>, 'done'>>,
	Assert<
		Equal<
			(typeof zodParityStatus)['enum'],
			{ readonly open: 'open'; readonly done: 'done'; readonly archived: 'archived' }
		>
	>,
	Assert<Equal<(typeof elementArray)['element'], KString>>,
	Assert<Equal<ReturnType<typeof defaultedString.removeDefault>, KString>>,
	Assert<Equal<k.output<typeof positiveNumber>, number>>,
] = [true, true, true, true, true, true, true, true, true]
const objectKeys = zodParityObject.keyof()
const requiredAll = zodParityObject.partial().required()
const requiredSome = zodParityObject.partial().required('a')
const extracted = zodParityStatus.extract(['done'])
const elementArray = k.array(k.string())
const defaultedString = k.string().default('x')
const positiveNumber = k.number().positive().nonnegative().negative().nonpositive().finite().safe()
void zodParityAssertions

const deriveRange = k.object({ from: k.number(), to: k.number().optional() }).refine(() => true)
const derivePicked = deriveRange.pick('from', { dropChecks: true })
const deriveOmitted = deriveRange.omit('to', { dropChecks: true })
const deriveRequired = deriveRange.required({ dropChecks: true })
const deriveRequiredSome = deriveRange.required('to', { dropChecks: true })
const derivePartial = deriveRange.partial({ dropChecks: true })
const deriveKept = deriveRange.extend({}, { keepChecks: true })
const deriveAssertions: [
	Assert<Equal<k.output<typeof derivePicked>, { from: number }>>,
	Assert<Equal<k.output<typeof deriveOmitted>, { from: number }>>,
	Assert<Equal<k.output<typeof deriveRequired>, { from: number; to: number }>>,
	Assert<Equal<k.output<typeof deriveRequiredSome>, { from: number; to: number }>>,
	Assert<Equal<k.output<typeof derivePartial>, { from?: number; to?: number }>>,
	Assert<Equal<k.output<typeof deriveKept>, { from: number; to?: number }>>,
] = [true, true, true, true, true, true]
void deriveAssertions
// @ts-expect-error keepChecks is only offered by extend.
deriveRange.pick('from', { keepChecks: true })
// @ts-expect-error keepChecks is only offered by extend.
deriveRange.partial({ keepChecks: true })
// @ts-expect-error a mask key must be a field.
deriveRange.omit('missing', { dropChecks: true })

const caughtRole = k.enum(['admin', 'member']).catch('member')
const caughtObject = k.object({
	role: caughtRole,
	note: k.string().optional().catch(undefined),
	n: k.number().catch(({ input }) => Number(input)),
})
const catchAssertions: [
	Assert<Equal<k.output<typeof caughtRole>, 'admin' | 'member'>>,
	Assert<Equal<k.input<typeof caughtRole>, 'admin' | 'member'>>,
	Assert<Equal<k.output<typeof caughtObject>, { role: 'admin' | 'member'; note?: string; n: number }>>,
	Assert<Equal<k.input<typeof caughtObject>, { role: 'admin' | 'member'; note?: string; n: number }>>,
	Assert<Equal<ReturnType<typeof caughtRole.unwrap>['_output'], 'admin' | 'member'>>,
] = [true, true, true, true, true]
void catchAssertions
// @ts-expect-error the fallback is the schema's output.
k.string().catch(1)

const looseHook = k.looseObject({ id: k.string(), n: k.number().optional() })
const looseChained = k.object({ id: k.string() }).loose().pick('id')
const plainJsonObject = k.jsonObject()
const looseAssertions: [
	Assert<Equal<k.output<typeof looseHook>, { id: string; n?: number }>>,
	Assert<Equal<k.output<typeof looseChained>, { id: string }>>,
	Assert<Equal<k.output<typeof plainJsonObject>, Record<string, JSONValue>>>,
	Assert<Equal<k.input<typeof plainJsonObject>, Record<string, JSONValue>>>,
] = [true, true, true, true]
void looseAssertions
