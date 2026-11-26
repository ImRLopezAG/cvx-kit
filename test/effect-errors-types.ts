import type { Effect } from 'effect'
import { k } from '../src/k'
import { defineErrorContract, type DeclaredError } from '../src/modules/contracts/errors'
import { defineDomainContract } from '../src/modules/contracts/domain'
import { createEffectFoundation, effectErrors } from '../src/effect'

const definitions = {
	NOT_FOUND: { message: 'Not found', details: {} },
	LIMIT: { message: 'Limit reached', details: { max: k.number() } },
} as const
const errors = defineErrorContract(definitions)
type Errors = typeof errors extends { create: (code: never, details: never) => infer Error }
	? Error
	: never
const { fail, attempt } = effectErrors(errors)

const missing: Effect.Effect<never, Extract<Errors, { code: 'NOT_FOUND' }>> = fail('NOT_FOUND')
const limited = fail('LIMIT', { max: 3 })
// @ts-expect-error Codes with declared detail fields require their details.
fail('LIMIT')
// @ts-expect-error Detail values keep their parsed types.
fail('LIMIT', { max: 'three' })
// @ts-expect-error Undeclared codes are rejected.
fail('UNKNOWN')
const attempted: Effect.Effect<number, DeclaredError<typeof definitions>> = attempt(async () => 1)
void [missing, limited, attempted]

const foundation = createEffectFoundation({
	observability: { enabled: false, classifyError: () => ({ outcome: 'failed', errorCode: 'F' }) },
	writeAudit: () => undefined,
})
foundation.Command({
	contract: defineDomainContract({
		errors,
		commands: { save: { input: k.string(), result: k.string(), classification: 'business' } },
	}),
	context: () => ({}),
	audit: () => null,
	operations: ({ command, fail: failSave }) => ({
		save: command.handler(() => failSave('NOT_FOUND')),
	}),
})
foundation.Command({
	contract: defineDomainContract({
		commands: { save: { input: k.string(), result: k.string(), classification: 'business' } },
	}),
	context: () => ({}),
	audit: () => null,
	// @ts-expect-error Contracts without declared errors offer no fail helper.
	operations: ({ command, fail: failSave }) => ({
		save: command.handler(() => failSave('NOT_FOUND')),
	}),
})
