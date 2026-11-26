import type { GenericId } from 'convex/values'
import type { z } from 'zod'
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
const length = toZod(k.string().transform((value) => value.length))

const assertions: [
	Assert<Equal<z.output<typeof converted>['owner'], GenericId<'users'>>>,
	Assert<Equal<z.output<typeof converted>, k.output<typeof task>>>,
	Assert<Equal<z.input<typeof converted>, k.input<typeof task>>>,
	Assert<Equal<z.output<typeof method>, k.output<typeof task>>>,
	Assert<Equal<z.output<typeof length>, string>>,
] = [true, true, true, true, true]
void assertions
