// Type tests for kVariantTable; checked by `bun run typecheck`, never executed.
import type { GenericId } from 'convex/values'
import { k } from '../src/k'
import { kVariantTable } from '../src/table'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

const storage = k.discriminatedUnion('kind', [
	k.object({
		kind: k.literal('draft'),
		client: k.id('clients'),
		amount: k.number(),
		secret: k.string(),
	}),
	k.object({
		kind: k.literal('creditor'),
		client: k.id('clients'),
		creditor: k.id('creditors'),
		amount: k.number(),
		secret: k.string(),
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
const table = kVariantTable('payments', storage, { discriminator: 'kind', variants })

declare const command: k.infer<typeof table.commandInput>
if (command.kind === 'creditor') {
	const creditorId: GenericId<'creditors'> = command.creditor
	void creditorId
} else {
	const clientId: GenericId<'clients'> = command.client
	void clientId
	// @ts-expect-error the creditor field belongs only to the creditor branch
	void command.creditor
}
// @ts-expect-error secrets are excluded from command inputs
void command.secret

declare const document: k.infer<typeof table.schema>
declare const dto: k.infer<ReturnType<typeof table.dto<true>>>
declare const publicRow: k.infer<typeof table.publicDto>
const checks: [
	Assert<Equal<typeof document._id, GenericId<'payments'>>>,
	Assert<Equal<typeof document._creationTime, number>>,
	Assert<Equal<typeof dto._id, GenericId<'payments'>>>,
	Assert<Equal<typeof table.tableName, 'payments'>>,
	Assert<Equal<keyof typeof publicRow, 'kind' | 'client'>>,
	Assert<Equal<k.infer<typeof table.tools.update>['id'], GenericId<'payments'>>>,
	Assert<Equal<k.infer<typeof table.tools.id>['id'], GenericId<'payments'>>>,
] = [true, true, true, true, true, true, true]
void checks
// @ts-expect-error amounts were not selected into the public boundary
void dto.amount
// @ts-expect-error secrets never entered the public mask
void dto.secret

const patch: k.input<typeof table.updateSchema> = { kind: 'draft', amount: 2 }
void patch
// @ts-expect-error the patch discriminator stays required
const missingTag: k.input<typeof table.updateSchema> = { amount: 2 }
void missingTag
const wrongBranch: k.input<typeof table.updateSchema> = {
	kind: 'draft',
	// @ts-expect-error partial patches keep branch-specific keys
	creditor: k.id('creditors').parse('creditors:1'),
}
void wrongBranch

// Option checks.
kVariantTable('payments', storage, {
	discriminator: 'kind',
	// @ts-expect-error wrong-branch mask key
	variants: { ...variants, draft: { commandFields: ['creditor'] } },
})
kVariantTable('payments', storage, {
	discriminator: 'kind',
	// @ts-expect-error unknown branch
	variants: { ...variants, extra: {} },
})
// @ts-expect-error missing branch
kVariantTable('payments', storage, { discriminator: 'kind', variants: { draft: {} } })
kVariantTable('payments', storage, {
	discriminator: 'kind',
	// @ts-expect-error server-owned command fields
	variants: { ...variants, draft: { serverFields: ['secret'], commandFields: ['secret'] } },
})
kVariantTable('payments', storage, {
	discriminator: 'kind',
	// @ts-expect-error the discriminator is retained automatically, not configurable in masks
	variants: { ...variants, draft: { publicFields: ['kind'] } },
})
kVariantTable('payments', storage, {
	discriminator: 'kind',
	// @ts-expect-error timestamps must be enabled before they can be selected
	variants: { ...variants, draft: { publicFields: ['createdAt'] } },
})
// @ts-expect-error mismatched discriminator
kVariantTable('payments', storage, { discriminator: 'type', variants })

const timestamped = kVariantTable('payments', storage, {
	discriminator: 'kind',
	timestamps: true,
	variants: { ...variants, draft: { publicFields: ['createdAt'] } },
})
declare const stored: k.infer<typeof timestamped.storage>
const timestampCheck: Assert<Equal<typeof stored.createdAt, number | undefined>> = true
void timestampCheck
timestamped.table.index('by_kind', ['kind']).index('by_created', ['createdAt'])
// @ts-expect-error an index cannot name an undeclared field
timestamped.table.index('by_missing', ['missing'])

const explicitStorage = k.discriminatedUnion('type', [
	k.object({
		type: k.literal('adjustment'),
		createdAt: k.int(),
		updatedAt: k.int(),
		archivedAt: k.int(),
		recordedAt: k.int(),
	}),
])
const explicit = kVariantTable('ledger', explicitStorage, {
	discriminator: 'type',
	timestamps: false,
	variants: {
		adjustment: {
			serverFields: ['createdAt', 'updatedAt', 'archivedAt', 'recordedAt'],
			commandFields: [],
			publicFields: ['createdAt'],
		},
	},
})
const explicitChecks: [
	Assert<
		Equal<
			keyof k.infer<typeof explicit.storage>,
			'type' | 'createdAt' | 'updatedAt' | 'archivedAt' | 'recordedAt'
		>
	>,
	Assert<Equal<k.infer<typeof explicit.storage>['createdAt'], number>>,
	Assert<Equal<keyof k.infer<typeof explicit.commandInput>, 'type'>>,
	Assert<Equal<keyof k.infer<typeof explicit.insertSchema>, 'type'>>,
	Assert<Equal<keyof k.infer<typeof explicit.updateSchema>, 'type'>>,
	Assert<Equal<keyof k.infer<typeof explicit.publicDto>, 'type' | 'createdAt'>>,
] = [true, true, true, true, true, true]
void explicitChecks

const writable = kVariantTable('ledger', explicitStorage, {
	discriminator: 'type',
	timestamps: false,
	variants: {
		adjustment: { commandFields: ['createdAt', 'updatedAt', 'archivedAt', 'recordedAt'] },
	},
})
declare const writablePatch: k.infer<typeof writable.updateSchema>
declare const writableToolPatch: k.infer<typeof writable.tools.update>['data']
const writableChecks: [
	Assert<Equal<typeof writablePatch.createdAt, number | undefined>>,
	Assert<Equal<typeof writablePatch.type, 'adjustment'>>,
	Assert<Equal<typeof writableToolPatch.recordedAt, number | undefined>>,
	Assert<Equal<k.infer<typeof writable.commandInput>['recordedAt'], number>>,
] = [true, true, true, true]
void writableChecks

// Legacy mode keeps the declared schema's own types.
const legacy = kVariantTable('events', storage)
const legacyChecks: [
	Assert<Equal<typeof legacy.storage, typeof storage>>,
	Assert<Equal<typeof legacy.insertSchema, typeof storage>>,
] = [true, true]
void legacyChecks
legacy.table.index('by_kind', ['kind'])
