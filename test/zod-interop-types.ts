import type { GenericId } from 'convex/values'
import { z } from 'zod'
import { k } from '../src/k'
import { toZod } from '../src/zod'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

const task = k.object({
	owner: k.id('users'),
	status: k.enum(['open', 'done']).default('open'),
	note: k.string().optional(),
})
const converted = toZod(task)
const method = task.toZod()
const source = k.string().transform((value) => value.length)
const length = toZod(source)
const classic = toZod(source, { zod: z })
const piped = source.pipe(k.number())
const classicPipe = toZod(piped, { zod: z })
const miniPipe = toZod(piped)
classic.optional()

const assertions: [
	Assert<Equal<z.output<typeof converted>['owner'], GenericId<'users'>>>,
	Assert<Equal<z.output<typeof converted>, k.output<typeof task>>>,
	Assert<Equal<z.input<typeof converted>, k.input<typeof task>>>,
	Assert<Equal<z.output<typeof method>, k.output<typeof task>>>,
	Assert<Equal<z.output<typeof length>, k.output<typeof source>>>,
	Assert<Equal<z.input<typeof length>, k.input<typeof source>>>,
	Assert<Equal<z.output<typeof classic>, k.output<typeof source>>>,
	Assert<Equal<z.input<typeof classic>, k.input<typeof source>>>,
	Assert<Equal<z.output<typeof classicPipe>, k.output<typeof piped>>>,
	Assert<Equal<z.input<typeof classicPipe>, k.input<typeof piped>>>,
	Assert<Equal<z.output<typeof miniPipe>, k.output<typeof piped>>>,
	Assert<Equal<z.input<typeof miniPipe>, k.input<typeof piped>>>,
] = [true, true, true, true, true, true, true, true, true, true, true, true]
void assertions
