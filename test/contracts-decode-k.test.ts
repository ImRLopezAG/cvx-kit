import { expect, it } from 'vite-plus/test'
import { ConvexError } from 'convex/values'
import { Effect } from 'effect'
import { k } from '../src/k'
import { decodeContract, kContract } from '../src/contracts'
import { createFoundation } from '../src/index'
import { workflowDecode } from '../src/modules/contracts/workflow'
import { ContractValidationError, decodeEffectContract } from '../src/modules/effect/schema'

it('returns strict validation issues for bare k schemas', async () => {
	const schema = k.object({ a: k.string() })
	await expect(decodeContract(schema, { a: 1 })).resolves.toMatchObject({
		issues: [{ path: ['a'], code: 'invalid_type' }],
	})
	await expect(decodeContract(schema, { a: 'ok', extra: true })).resolves.toMatchObject({
		issues: [{ path: ['extra'], code: 'unrecognized_key' }],
	})
	await expect(decodeContract(schema, { a: 'ok' })).resolves.toEqual({ value: { a: 'ok' } })
})

it('preserves throws from legacy parse-only contracts', async () => {
	const failure = new Error('legacy parse failure')
	const schema = {
		parse: () => {
			throw failure
		},
	}
	await expect(decodeContract(schema, 'bad')).rejects.toBe(failure)
	const exit = await Effect.runPromiseExit(decodeEffectContract(schema, 'bad'))
	expect(exit._tag).toBe('Failure')
	if (exit._tag !== 'Failure') throw Error('expected failure')
	expect(exit.cause.reasons[0]).toMatchObject({ _tag: 'Die', defect: failure })
})

it('preserves structured validation errors and issue paths in foundation commands', async () => {
	const { Command } = createFoundation({
		observability: {
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'FAIL' }),
		},
		writeAudit: () => undefined,
	})
	const commands = Command({
		context: (host: {}) => host,
		operations: ({ command }) => ({
			save: command({
				input: k.object({ a: k.string().min(2) }),
				result: k.string(),
				classification: 'business',
				audit: () => null,
				handler: (input) => input.a,
			}),
		}),
	})
	await expect(commands.exec('save', { a: 'ok' }, {})).resolves.toBe('ok')
	await expect(commands.exec('save', { a: 'x' }, {})).rejects.toBeInstanceOf(ConvexError)
	await expect(commands.exec('save', { a: 'x' }, {})).rejects.toMatchObject({
		data: { code: 'VALIDATION', issues: [{ path: ['a'], code: 'too_small' }] },
	})
})

it('preserves structured validation errors and issue paths in workflow contracts', async () => {
	const schema = k.object({ a: k.string() })
	await expect(workflowDecode(schema, { a: 'ok' })).resolves.toEqual({ a: 'ok' })
	await expect(workflowDecode(schema, { a: 1 })).rejects.toBeInstanceOf(ConvexError)
	await expect(workflowDecode(schema, { a: 1 })).rejects.toMatchObject({
		data: { code: 'VALIDATION', issues: [{ path: ['a'], code: 'invalid_type' }] },
	})
})

it('keeps a bare k failure in Effect a defect that carries the VALIDATION error', async () => {
	const schema = k.object({ a: k.string() })
	const bare = await Effect.runPromiseExit(decodeEffectContract(schema, { a: 1 }))
	expect(bare._tag).toBe('Failure')
	if (bare._tag !== 'Failure') throw Error('expected failure')
	const reason = bare.cause.reasons[0]
	expect(reason?._tag).toBe('Die')
	if (reason?._tag !== 'Die') throw Error('expected a defect')
	// The client of an Effect registry receives this ConvexError, with its code and issue paths.
	expect(reason.defect).toBeInstanceOf(ConvexError)
	expect(reason.defect).toMatchObject({
		data: { code: 'VALIDATION', issues: [{ path: ['a'], code: 'invalid_type' }] },
	})
	// The explicit adapter is the typed channel.
	const adapted = await Effect.runPromiseExit(decodeEffectContract(kContract(schema), { a: 1 }))
	if (adapted._tag !== 'Failure') throw Error('expected failure')
	const typed = adapted.cause.reasons[0]
	expect(typed?._tag).toBe('Fail')
	if (typed?._tag !== 'Fail') throw Error('expected typed validation failure')
	expect(typed.error).toBeInstanceOf(ContractValidationError)
	await expect(Effect.runPromise(decodeEffectContract(schema, { a: 'ok' }))).resolves.toEqual({
		a: 'ok',
	})
})
