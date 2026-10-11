import type { ConvexValidatorFromZod } from 'convex-helpers/server/zod4'
import type { GenericId, Infer } from 'convex/values'
import { z } from 'zod'
import * as mini from 'zod/mini'
import { zid, zodToConvex } from '../src/zod-table'

// The public wrapper retains the original core signature and exact return relationship.
const compatible: <Z extends z.core.$ZodType>(schema: Z) => ConvexValidatorFromZod<Z, 'required'> =
	zodToConvex
const schema = z.object({
	id: zid('tasks'),
	optional: z.number().optional(),
	nullable: z.string().nullable(),
	required: z.string().optional().nonoptional(),
})
const native = compatible(schema)
const value: Infer<typeof native> = {
	id: zid('tasks').parse('tasks:1'),
	nullable: null,
	required: 'yes',
}
const branded: GenericId<'tasks'> = value.id
// @ts-expect-error native IDs remain table branded
const wrong: GenericId<'labels'> = value.id
// @ts-expect-error nonoptional stays required
const missing: Infer<typeof native> = { id: branded, nullable: null }
const miniNative = compatible(mini.object({ id: zid('tasks'), names: mini.array(mini.string()) }))
const miniValue: Infer<typeof miniNative> = { id: branded, names: ['name'] }
// @ts-expect-error Mini field types remain precise
const badMini: Infer<typeof miniNative> = { id: branded, names: [1] }
const inputNative = compatible(z.string().transform((s) => s.length))
const input: Infer<typeof inputNative> = 'input'
// @ts-expect-error conversion follows pipe input rather than output
const output: Infer<typeof inputNative> = 1
void [value, branded, wrong, missing, miniValue, badMini, input, output]
