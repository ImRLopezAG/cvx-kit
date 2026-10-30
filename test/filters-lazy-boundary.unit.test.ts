import { describe, expect, test } from 'vite-plus/test'
import { z } from 'zod'
import {
	lazyRelationFilterSchema,
	relationFilterSchema,
	scalarPredicateFromSchema,
	type FilterGrammar,
} from '../src/querying/shared/filters'

/**
 * people -team(one)-> teams -members(many)-> people, plus a variant table whose
 * branches carry their own relation. Relation getters count their reads.
 */
function grammars() {
	const reads: string[] = []
	const scalar = (schema: z.ZodType, range = false, optional = false) =>
		scalarPredicateFromSchema(schema, range, optional).optional()
	const people: FilterGrammar = {
		fields: {
			name: scalar(z.string()),
			age: scalar(z.number(), true),
			nick: scalar(z.string(), false, true),
		},
		relations: {},
	}
	const teams: FilterGrammar = { fields: { title: scalar(z.string()) }, relations: {} }
	const card: FilterGrammar = { fields: { last4: scalar(z.string()) }, relations: {} }
	const cash: FilterGrammar = { fields: { till: scalar(z.number(), true) }, relations: {} }
	const payments: FilterGrammar = {
		fields: { kind: scalar(z.enum(['card', 'cash'])), amount: scalar(z.number(), true) },
		variants: { discriminator: 'kind', options: { card, cash } },
		relations: {},
	}
	function relate(
		source: FilterGrammar,
		name: string,
		cardinality: 'one' | 'many',
		target: () => FilterGrammar,
	) {
		Object.defineProperty(source.relations, name, {
			enumerable: true,
			get: () => {
				reads.push(name)
				return { cardinality, target: target() }
			},
		})
	}
	relate(people, 'team', 'one', () => teams)
	relate(teams, 'members', 'many', () => people)
	relate(people, 'payments', 'many', () => payments)
	relate(card, 'owner', 'one', () => people)
	return { people, reads }
}

const corpus: unknown[] = [
	undefined,
	{},
	{ name: 'a' },
	{ name: { eq: 'a' }, age: { gt: 1, lte: 9 } },
	{ nick: { exists: false } },
	{ fields: { name: 'a', age: { gte: 3 } } },
	{ team: null },
	{ team: { title: 'x' } },
	{ team: { members: { some: { name: 'a' } } } },
	{ team: { members: { none: { team: { title: 'y' } } } } },
	{ team: { members: { some: { team: { members: { some: { name: 'deep' } } } } } } },
	{ and: [{ name: 'a' }, { team: { title: 'x' } }] },
	{ or: [{ payments: { some: { amount: { gt: 1 } } } }, { not: { team: null } }] },
	{ not: { and: [{ not: { team: { members: { some: {} } } } }] } },
	{ payments: { some: { variant: { tag: 'card', filters: { last4: '1234' } } } } },
	{ payments: { some: { variant: { tag: 'card', filters: { owner: { name: 'a' } } } } } },
	{ payments: { none: { variant: { tag: 'cash', filters: { till: { lt: 3 } } } } } },
	// Invalid inputs.
	{ unknown: 1 },
	{ name: { eq: 1 } },
	{ name: {} },
	{ team: { some: { title: 'x' } } },
	{ team: { members: { title: 'x' } } },
	{ team: { members: { some: {}, none: {} } } },
	{ team: { members: { any: {} } } },
	{ payments: { some: { variant: { tag: 'cheque', filters: {} } } } },
	{ payments: { some: { variant: { tag: 'cash', filters: { last4: '1' } } } } },
	{ team: { members: { some: { team: { members: { some: { team: { title: 'x' } } } } } } } },
	{ and: [] },
	{ and: Array.from({ length: 300 }, () => ({ name: 'a' })) },
	{ constructor: { some: {} } },
	{ toString: null },
	JSON.parse('{"__proto__": {"name": "a"}}'),
	Object.create({ name: 'inherited' }),
	[],
	'name',
	null,
]

describe('lazy engine filter boundary', () => {
	test('accepts, rejects and outputs exactly what the eager boundary does', () => {
		for (const input of corpus) {
			const eager = relationFilterSchema(grammars().people).optional().safeParse(input)
			const lazy = lazyRelationFilterSchema(grammars().people).optional().safeParse(input)
			expect(lazy.success, JSON.stringify(input)).toBe(eager.success)
			if (eager.success) expect(lazy.data, JSON.stringify(input)).toEqual(eager.data)
		}
	})

	test('one lazy schema stays exact across many inputs and reuses its shapes', () => {
		const schema = lazyRelationFilterSchema(grammars().people).optional()
		for (const round of [0, 1])
			for (const input of corpus) {
				const eager = relationFilterSchema(grammars().people).optional().safeParse(input)
				expect(schema.safeParse(input).success, `${round} ${JSON.stringify(input)}`).toBe(
					eager.success,
				)
			}
	})

	test('reads only the relations an input names', () => {
		const { people, reads } = grammars()
		const schema = lazyRelationFilterSchema(people)
		expect(reads).toEqual([])
		schema.parse({ name: 'a', and: [{ age: { gt: 1 } }] })
		expect(reads).toEqual([])
		schema.parse({ team: { title: 'x' } })
		expect(new Set(reads)).toEqual(new Set(['team']))
		reads.length = 0
		schema.parse({ payments: { some: { variant: { tag: 'card', filters: { last4: '1' } } } } })
		expect(new Set(reads)).toEqual(new Set(['payments']))
		// The eager boundary reads every relation up front.
		const eager = grammars()
		relationFilterSchema(eager.people)
		expect(new Set(eager.reads)).toEqual(new Set(['team', 'members', 'payments', 'owner']))
	})

	test('shared-target fan-out costs work linear in the input, cold and warm', () => {
		// 32 one-to-one self relations; at each of four levels the input names all
		// of them and extends only r0. Keying restrictions by path was exponential.
		function fanOut() {
			let reads = 0
			const people: FilterGrammar = {
				fields: { name: scalarPredicateFromSchema(z.string(), false, false).optional() },
				relations: {},
			}
			for (let i = 0; i < 32; i++)
				Object.defineProperty(people.relations, `r${i}`, {
					enumerable: true,
					get: () => {
						reads++
						return { cardinality: 'one', target: people }
					},
				})
			return { people, reads: () => reads }
		}
		interface FanOutFilter {
			[relation: string]: FanOutFilter | string
		}
		const level = (child: FanOutFilter): FanOutFilter =>
			Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`r${i}`, i ? {} : child]))
		const input = level(level(level(level({ name: 'deep' }))))
		const lazy = fanOut()
		const schema = lazyRelationFilterSchema(lazy.people)
		const result = schema.safeParse(input)
		const cold = lazy.reads()
		expect(cold).toBeLessThan(2000)
		schema.safeParse(input)
		expect(lazy.reads() - cold).toBeLessThan(1000)
		const eager = relationFilterSchema(fanOut().people).safeParse(input)
		expect(result.success).toBe(eager.success)
		if (eager.success) expect(result.data).toEqual(eager.data)
	})
})
