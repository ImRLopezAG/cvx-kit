import type { GenericId } from 'convex/values'
import { expectTypeOf } from 'vite-plus/test'
import { z } from 'zod'

import { defineRelations } from '../src/relations'
import { zodVariantTable, zid } from '../src/zod-table'

const storage = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('draft'),
		client: zid('clients'),
		amount: z.number(),
		secret: z.string(),
	}),
	z.strictObject({
		kind: z.literal('creditor'),
		client: zid('clients'),
		creditor: zid('creditors'),
		amount: z.number(),
		secret: z.string(),
	}),
])
const variants = {
	draft: {
		serverFields: ['secret'],
		commandFields: ['client', 'amount'],
		publicFields: ['client'],
	},
	creditor: {
		serverFields: ['secret'],
		commandFields: ['client', 'creditor', 'amount'],
		publicFields: ['client', 'creditor'],
	},
} as const
const table = zodVariantTable('payments', storage, { discriminator: 'kind', variants })

declare const command: z.output<typeof table.commandInput>
if (command.kind === 'creditor') {
	expectTypeOf(command.creditor).toEqualTypeOf<GenericId<'creditors'>>()
} else {
	expectTypeOf(command.client).toEqualTypeOf<GenericId<'clients'>>()
	// @ts-expect-error creditor field belongs only to the creditor branch
	void command.creditor
}
// @ts-expect-error secrets are excluded from command inputs
void command.secret
declare const document: z.output<typeof table.schema>
expectTypeOf(document._id).toEqualTypeOf<GenericId<'payments'>>()
expectTypeOf(document._creationTime).toEqualTypeOf<number>()
if (document.kind === 'creditor')
	expectTypeOf(document.creditor).toEqualTypeOf<GenericId<'creditors'>>()
declare const dto: z.output<ReturnType<typeof table.dto<true>>>
expectTypeOf(dto._id).toEqualTypeOf<GenericId<'payments'>>()
if (dto.kind === 'creditor') expectTypeOf(dto.creditor).toEqualTypeOf<GenericId<'creditors'>>()
// @ts-expect-error amounts were not selected into the public boundary
void dto.amount
// @ts-expect-error secrets never entered the public mask
void dto.secret
declare const tool: z.output<typeof table.tools.insert>
if (tool.kind === 'creditor') expectTypeOf(tool.creditor).toEqualTypeOf<GenericId<'creditors'>>()
declare const dynamicDto: z.output<ReturnType<typeof table.dto<boolean>>>
if ('_id' in dynamicDto) expectTypeOf(dynamicDto._id).toEqualTypeOf<GenericId<'payments'>>()
const patch: z.input<typeof table.updateSchema> = { kind: 'draft', amount: 2 }
void patch
// @ts-expect-error patch discriminator remains required
const missingTag: z.input<typeof table.updateSchema> = { amount: 2 }
void missingTag
// @ts-expect-error partial patches retain branch-specific keys
const wrongBranch: z.input<typeof table.updateSchema> = { kind: 'draft', creditor: 'creditors:1' }
void wrongBranch
zodVariantTable('payments', storage, {
	discriminator: 'kind',
	// @ts-expect-error wrong-branch mask key
	variants: { ...variants, draft: { commandFields: ['creditor'] } },
})
zodVariantTable('payments', storage, {
	discriminator: 'kind',
	// @ts-expect-error unknown branch
	variants: { ...variants, extra: {} },
})
// @ts-expect-error missing branch
zodVariantTable('payments', storage, { discriminator: 'kind', variants: { draft: {} } })
zodVariantTable('payments', storage, {
	discriminator: 'kind',
	// @ts-expect-error server-owned command fields
	variants: { ...variants, draft: { serverFields: ['secret'], commandFields: ['secret'] } },
})
zodVariantTable('payments', storage, {
	discriminator: 'kind',
	// @ts-expect-error discriminator retained automatically, not configurable in masks
	variants: { ...variants, draft: { publicFields: ['kind'] } },
})
zodVariantTable('payments', storage, {
	discriminator: 'kind',
	// @ts-expect-error timestamps must be enabled before they can be selected
	variants: { ...variants, draft: { publicFields: ['createdAt'] } },
})
// @ts-expect-error mismatched discriminator
zodVariantTable('payments', storage, { discriminator: 'type', variants })
defineRelations({ payments: table }, () => ({}))

const timestamped = zodVariantTable('payments', storage, {
	discriminator: 'kind',
	timestamps: true,
	variants: { ...variants, draft: { publicFields: ['createdAt'] } },
})
expectTypeOf(timestamped.storage.parse({}).createdAt).toEqualTypeOf<number | undefined>()
