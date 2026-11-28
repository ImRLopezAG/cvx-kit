// U16: `k` schemas on the contract seam and through the single Effect API builder.
import { convexTest } from 'convex-test'
import { defineSchema, makeFunctionReference, queryGeneric } from 'convex/server'
import { ConvexError } from 'convex/values'
import { Effect, Exit } from 'effect'
import { describe, expect, it } from 'vite-plus/test'
import { decodeContract, kContract } from '../src/contracts'
import { defineErrorContract } from '../src/errors'
import { ContractValidationError, createEffectFoundation, effectApiBuilder } from '../src/effect'
import { k } from '../src/k'

const foundation = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'FAILURE' }),
	},
	writeAudit: () => undefined,
})

describe('kContract', () => {
	it('decodes to the output side: defaults filled and transforms applied', async () => {
		const contract = kContract(
			k.object({ title: k.string().trim(), size: k.string().transform((value) => value.length) }),
		)
		expect(await decodeContract(contract, { title: ' a ', size: 'four' })).toEqual({
			value: { title: 'a', size: 4 },
		})
		expect(contract.decode({ title: 'a', size: 'x' })).toEqual({ value: { title: 'a', size: 1 } })
	})

	it('returns KTD6 issues as a validation result instead of throwing', () => {
		const contract = kContract(k.object({ title: k.string().min(2) }))
		const result = contract.decode({ title: 'a', extra: true })
		expect(result.issues).toEqual([
			expect.objectContaining({ path: ['title'], code: 'too_small' }),
			expect.objectContaining({ path: ['extra'], code: 'unrecognized_key' }),
		])
	})

	it('exposes the pre-transform input to callers and the post-transform value to the handler', async () => {
		const seen: unknown[] = []
		const commands = foundation.Command({
			context: (host: { prefix: string }) => host,
			operations: ({ command }) => ({
				rename: command({
					input: kContract(
						k.object({
							name: k.string().transform((value) => value.toUpperCase()),
							count: k.int().default(1),
						}),
					),
					result: k.string(),
					classification: 'business',
					audit: () => null,
					handler: (input, host) => {
						seen.push(input)
						return `${host.prefix}${input.name}:${input.count}`
					},
				}),
			}),
		})
		expect(await Effect.runPromise(commands.exec('rename', { name: 'ada' }, { prefix: '>' }))).toBe(
			'>ADA:1',
		)
		expect(seen).toEqual([{ name: 'ADA', count: 1 }])
		const invalid = await Effect.runPromiseExit(
			// SAFETY: deliberately wrong transport input exercises the contract's validation channel.
			// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The invalid value is the subject.
			commands.exec('rename', { name: 1 as unknown as string }, { prefix: '>' }),
		)
		if (!Exit.isFailure(invalid)) throw Error('expected a validation failure')
		const reason = invalid.cause.reasons[0]
		if (reason?._tag !== 'Fail') throw Error('expected a typed validation failure')
		expect(reason.error).toBeInstanceOf(ContractValidationError)
		expect(seen).toHaveLength(1)
	})
})

describe('declared errors with k', () => {
	const errors = defineErrorContract({
		INVALID_INPUT: { message: 'Invalid input', details: { field: k.string() } },
	})

	it('maps a k validation failure to its declared code through the Effect API boundary', async () => {
		const input = kContract(k.object({ title: k.string().min(3) }))
		const query = effectApiBuilder(queryGeneric, { errors })
		const check = query({
			args: { title: k.string() },
			returns: k.string(),
			handler: (_ctx, args) =>
				Effect.suspend(() => {
					const decoded = input.decode(args)
					if (!decoded.issues) return Effect.succeed(decoded.value.title)
					return Effect.fail(
						errors.create('INVALID_INPUT', { field: String(decoded.issues[0]?.path?.[0]) }),
					)
				}),
		})
		const t = convexTest(defineSchema({}), {
			'./_generated/server.ts': async () => ({}),
			'./functions.ts': async () => ({ check }),
		})
		const ref = makeFunctionReference<'query', { title: string }, string>('functions:check')
		expect(await t.query(ref, { title: 'long' })).toBe('long')
		const failure = await t.query(ref, { title: 'no' }).then(
			() => undefined,
			(error: ConvexError<string>) => error,
		)
		expect(failure).toBeInstanceOf(ConvexError)
		expect(errors.decode(failure?.data)).toEqual({
			_tag: 'DeclaredFailure',
			version: 1,
			code: 'INVALID_INPUT',
			message: 'Invalid input',
			details: { field: 'title' },
		})
	})

	it('rejects declared details that fail their k parser', () => {
		// SAFETY: deliberately invalid runtime details prove the k parser guards the envelope.
		// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The invalid value is the subject.
		expect(() => errors.create('INVALID_INPUT', { field: 1 as unknown as string })).toThrow(
			'Invalid declared error details',
		)
	})
})

describe('effectApiBuilder over a native builder', () => {
	it('runs k args defaults, transforms and checks before the handler', async () => {
		const query = effectApiBuilder(queryGeneric, {})
		const load = query({
			args: { name: k.string().min(1).transform((value) => value.length), limit: k.int().default(5) },
			handler: (_ctx, args) => Effect.succeed(`${args.name}:${args.limit}`),
		})
		const t = convexTest(defineSchema({}), {
			'./_generated/server.ts': async () => ({}),
			'./functions.ts': async () => ({ load }),
		})
		const ref = makeFunctionReference<'query', { name: string; limit?: number }, string>(
			'functions:load',
		)
		expect(await t.query(ref, { name: 'abc' })).toBe('3:5')
		await expect(t.query(ref, { name: '' })).rejects.toMatchObject({
			data: { code: 'VALIDATION', issues: [{ path: ['name'], code: 'too_small' }] },
		})
	})

	it('parses fully under skipConvexValidation and rejects unknown keys', async () => {
		const query = effectApiBuilder(queryGeneric, {})
		const load = query({
			args: k.object({ n: k.int() }),
			skipConvexValidation: true,
			handler: (_ctx, args) => Effect.succeed(args.n * 2),
		})
		const t = convexTest(defineSchema({}), {
			'./_generated/server.ts': async () => ({}),
			'./functions.ts': async () => ({ load }),
		})
		const ref = makeFunctionReference<'query', { n: number }, number>('functions:load')
		expect(await t.query(ref, { n: 2 })).toBe(4)
		const loose = makeFunctionReference<'query', { n: number; extra?: number }, number>(
			'functions:load',
		)
		await expect(t.query(loose, { n: 2, extra: 1 })).rejects.toMatchObject({
			data: { code: 'VALIDATION', issues: [{ path: ['extra'], code: 'unrecognized_key' }] },
		})
	})
})
