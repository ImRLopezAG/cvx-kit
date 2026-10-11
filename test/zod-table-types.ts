import type { GenericId } from 'convex/values'
import { z } from 'zod'
import { zodTable, type DtoOptions } from '../src/zod-table'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

const table = zodTable(
	'documents',
	() => ({ title: z.string(), note: z.string().optional(), secret: z.string() }),
	{ publicFields: ['title', 'note'] },
)
const row = { title: 't', secret: 's', _id: 'documents:1' }
const ordinary = table.toPublicDto(row)
const shorthand = table.toPublicDto(row, true)
const explicit = table.toPublicDto(row, { _id: true })
const disabled = table.toPublicDto(row, false)
const explicitDisabled = table.toPublicDto(row, { _id: false })
const defaultOptions = table.toPublicDto(row, {})
const extend = {
	url: z.string(),
	count: z.number().int(),
	extra: z.number().optional(),
}
const extended = table.toPublicDto(row, { _id: true, extend, values: { url: 'u', count: 3 } })
const schema = table.dto({ _id: true, extend })
const falseSchema = table.dto({ _id: false })
const defaultSchema = table.dto()
const shorthandSchema = table.dto(true)
const defaultExtended = table.toPublicDto(row, { extend, values: { url: 'u', count: 3 } })
declare const flag: boolean
const dynamic = table.toPublicDto(row, flag)

const assertions: [
	Assert<Equal<typeof shorthand._id, GenericId<'documents'>>>,
	Assert<Equal<typeof explicit, typeof shorthand>>,
	Assert<Equal<typeof disabled, typeof ordinary>>,
	Assert<Equal<typeof explicitDisabled, typeof ordinary>>,
	Assert<Equal<typeof defaultOptions, typeof ordinary>>,
	Assert<Equal<z.output<typeof schema>, typeof extended>>,
	Assert<Equal<z.output<typeof falseSchema>, typeof ordinary>>,
	Assert<Equal<z.output<typeof defaultSchema>, typeof ordinary>>,
	Assert<Equal<z.output<typeof shorthandSchema>, typeof shorthand>>,
	Assert<Equal<typeof extended.count, number>>,
	Assert<Equal<typeof extended.extra, number | undefined>>,
] = [true, true, true, true, true, true, true, true, true, true, true]
void assertions
void dynamic
// @ts-expect-error default extensions do not implicitly include an id
void defaultExtended._id
// @ts-expect-error unselected fields remain absent
void ordinary.secret
// @ts-expect-error shorthand does not expose creation time
void shorthand._creationTime
// @ts-expect-error wrong table brand
const wrongId: GenericId<'users'> = shorthand._id
void wrongId
// @ts-expect-error requested id requires id-bearing input
table.toPublicDto({ title: 't', secret: 's' }, { _id: true })
// @ts-expect-error values must match schema input
table.toPublicDto(row, { extend, values: { url: 'u', count: 'abc' } })
// @ts-expect-error required values cannot be omitted
table.toPublicDto(row, { extend })
// @ts-expect-error values cannot be supplied without schemas
table.toPublicDto(row, { values: { url: 'u' } })
// @ts-expect-error projected collisions are rejected
table.dto({ extend: { title: z.number() } })
// @ts-expect-error reserved id collisions are rejected even with id disabled
table.dto({ _id: false, extend: { _id: z.string() } })
// @ts-expect-error creation time is reserved
table.toPublicDto(row, { extend: { _creationTime: z.number() }, values: { _creationTime: 1 } })
// @ts-expect-error timestamps are reserved
table.dto({ extend: { createdAt: z.number() } })
// @ts-expect-error tenant ownership is reserved
table.dto({ extend: { tenant: z.string() } })
// @ts-expect-error Zod silently omits this key, so it cannot be promised in output
table.dto({ extend: { ['__proto__']: z.string() } })
table.toPublicDto(row, {
	// @ts-expect-error extension keys remain known when some keys collide
	extend: { url: z.string(), title: z.string() },
	values: { url: 'u', title: 't' },
})

// @ts-expect-error explicit generic cannot promise an absent id
table.toPublicDto<true>(row, {})
// @ts-expect-error explicit generic cannot promise an absent id schema
table.dto<true>({})
// @ts-expect-error reusable options must include a promised id
const missingId: DtoOptions<true> = {}
void missingId
// @ts-expect-error explicit generic requires the contributing extension schema
table.dto<false, typeof extend>({})
// @ts-expect-error values cannot stand in for the omitted extension schema
table.toPublicDto<false, typeof extend>(row, { values: { url: 'u', count: 3 } })
// @ts-expect-error reusable options cannot omit nonempty extensions
const missingExtension: DtoOptions<false, typeof extend> = {}
void missingExtension
const reusable: DtoOptions<true, typeof extend> = { _id: true, extend }
const reused = table.toPublicDto(row, { ...reusable, values: { url: 'u', count: 3 } })
const reusedId: GenericId<'documents'> = reused._id
void reusedId

// @ts-expect-error transforms cannot serve as extension return validators
table.dto({ extend: { size: z.string().transform((value) => value.length) } })
// @ts-expect-error pipes cannot serve as extension return validators
table.toPublicDto(row, { extend: { name: z.string().pipe(z.string()) }, values: { name: 'n' } })
const broad: DtoOptions<boolean, Record<string, z.ZodType>> = { extend: {} }
const broadDto = table.toPublicDto(row, { ...broad, values: {} })
// @ts-expect-error a broad schema dictionary cannot promise a particular field
void broadDto.url
// @ts-expect-error optional broad id inclusion cannot promise a required id
const broadId: GenericId<'documents'> = broadDto._id
void broadId

type OptionalExtensionOptions = { extend?: typeof extend }
const optionalExtension: OptionalExtensionOptions = {}
// @ts-expect-error reusable optional schemas cannot promise absent fields
table.dto(optionalExtension)
// @ts-expect-error supplied values cannot make an optional schema contribution required
table.toPublicDto(row, { ...optionalExtension, values: { url: 'u', count: 3 } })
const optionalId: DtoOptions<boolean> = {}
const maybeId = table.toPublicDto(row, optionalId)
// @ts-expect-error an optional boolean id flag cannot promise a required id
const requiredId: GenericId<'documents'> = maybeId._id
void requiredId
