/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/no-known-value-widening -- Runtime-failure fixture deliberately erases helper and host types to reach the binding checks a typed caller cannot. */
import { expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { defineDomainContract } from '../src/contracts'
import { createFoundation } from '../src/index'

function counted() {
	const reads: string[] = []
	const track = <Value>(name: string, value: Value) => {
		reads.push(name)
		return value
	}
	return { reads, track }
}

function lazyContract(track: <Value>(name: string, value: Value) => Value) {
	return {
		commands: {
			get save() {
				return track('save', {
					input: z.string().transform(Number),
					result: z.number(),
					classification: 'business',
				})
			},
		},
		queries: {
			get a() {
				return track('a', {
					get input() {
						return track('a.input', z.number())
					},
					get result() {
						return track('a.result', z.number())
					},
				})
			},
			get b() {
				return track('b', { input: z.string(), result: z.string() })
			},
		},
	}
}

function foundation() {
	return createFoundation({
		observability: {
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'FAIL' }),
		},
		writeAudit: () => {},
	})
}

for (const form of ['data', 'thunk'] as const) {
	it(`builds only the read operation and field, once (${form} form)`, () => {
		const { reads, track } = counted()
		const contract =
			form === 'data'
				? defineDomainContract(lazyContract(track))
				: defineDomainContract(() => lazyContract(track))
		expect(reads).toEqual([])
		expect(Object.keys(contract.queries)).toEqual(['a', 'b'])
		expect(reads).toEqual([])
		const input = contract.queries.a.input
		expect(reads).toEqual(['a', 'a.input'])
		expect(contract.queries.a.input).toBe(input)
		expect(contract.queries.a).toBe(contract.queries.a)
		expect(reads).toEqual(['a', 'a.input'])
	})

	it(`binds only the executed operation (${form} form)`, async () => {
		const { reads, track } = counted()
		const contract =
			form === 'data'
				? defineDomainContract(lazyContract(track))
				: defineDomainContract(() => lazyContract(track))
		const queries = foundation().Query({
			contract,
			context: () => ({}),
			operations: ({ query }) => ({
				a: query.a({ handler: (input) => input + 1 }),
				b: query.handler((input) => input),
			}),
		})
		expect(reads).toEqual([])
		expect(await queries.exec('a', 1, {} as never)).toBe(2)
		expect(reads).not.toContain('b')
		expect(await queries.exec('a', 2, {} as never)).toBe(3)
		expect(reads.filter((name) => name === 'a')).toHaveLength(1)
	})
}

it('keeps eager key-set checks for lazy operations', () => {
	const { track } = counted()
	const contract = defineDomainContract(lazyContract(track))
	expect(() =>
		foundation().Query({
			contract,
			context: () => ({}),
			// SAFETY: the missing key is the runtime failure under test.
			operations: (({ query }: never) => ({
				a: (query as never as { handler: Function }).handler(() => 1),
			})) as never,
		}),
	).toThrow('keys must match exactly')
})

it('surfaces a foreign helper for a lazy operation on its first execution, then rethrows', async () => {
	const { reads, track } = counted()
	const contract = defineDomainContract(lazyContract(track))
	const other = defineDomainContract(lazyContract(track))
	const otherQueries = foundation().Query({
		contract: other,
		context: () => ({}),
		operations: ({ query }) => ({
			a: query.handler((input) => input),
			b: query.handler((input) => input),
		}),
	})
	let foreign: unknown
	foundation().Query({
		contract: other,
		context: () => ({}),
		operations: ({ query }) => {
			foreign = query.b({ handler: (input) => input })
			return { a: query.handler((input) => input), b: foreign as never }
		},
	})
	const queries = foundation().Query({
		contract,
		context: () => ({}),
		operations: ({ query }) => ({
			a: query.handler((input) => input),
			b: foreign as never,
		}),
	})
	expect(await queries.exec('a', 1, {} as never)).toBe(1)
	await expect(queries.exec('b', 'x' as never, {} as never)).rejects.toThrow('own contract helper')
	await expect(queries.exec('b', 'x' as never, {} as never)).rejects.toThrow('own contract helper')
	expect(await otherQueries.exec('b', 'y', {} as never)).toBe('y')
	expect(reads).toContain('b')
})

it('surfaces a protected-field override on first execution with the eager message', async () => {
	const { track } = counted()
	const contract = defineDomainContract(lazyContract(track))
	const queries = foundation().Query({
		contract,
		context: () => ({}),
		operations: ({ query }) => ({
			a: query.handler((input) => input),
			// SAFETY: the protected override is the runtime failure under test.
			b: query.b({ handler: (input: string) => input, input: z.string() } as never),
		}),
	})
	expect(await queries.exec('a', 1, {} as never)).toBe(1)
	await expect(queries.exec('b', 'x' as never, {} as never)).rejects.toThrow(
		'Contracted operation b cannot override input',
	)
})

it('requires an audit callback for a lazy command on first execution and never runs it', async () => {
	const { track } = counted()
	const contract = defineDomainContract(lazyContract(track))
	let ran = 0
	const commands = foundation().Command({
		contract,
		context: () => ({}),
		// SAFETY: the missing audit callback is the runtime failure under test.
		...({} as { audit: never }),
		operations: ({ command }) => ({
			save: command.handler((input) => {
				ran++
				return input
			}),
		}),
	})
	await expect(commands.exec('save', '1', {} as never)).rejects.toThrow(
		'Command save requires an audit callback',
	)
	await expect(commands.exec('save', '1', {} as never)).rejects.toThrow(
		'Command save requires an audit callback',
	)
	expect(ran).toBe(0)
})

it('validates a lazy helper result registered without a contract, like a data-declared one', async () => {
	const { track } = counted()
	const data = lazyContract(track)
	const eager = defineDomainContract({
		queries: { a: { input: z.number(), result: z.number() }, b: data.queries.b },
	})
	const lazy = defineDomainContract(lazyContract(track))
	const outcomes = []
	for (const contract of [eager, lazy]) {
		let helper: unknown
		foundation().Query({
			contract,
			context: () => ({}),
			operations: ({ query }) => {
				helper = query.a({ handler: (input) => input + 1 })
				return { a: helper as never, b: query.handler((input) => input) }
			},
		})
		const queries = foundation().Query({
			context: () => ({}),
			operations: () => ({ a: helper as never }),
		})
		const accepted = await queries.exec('a', 1 as never, {} as never)
		const rejected = await queries.exec('a', 'x' as never, {} as never).then(
			() => 'accepted',
			(error: Error) => error.constructor.name,
		)
		outcomes.push([accepted, rejected])
	}
	expect(outcomes[1]).toEqual(outcomes[0])
	expect(outcomes[0]![1]).not.toBe('accepted')
})
