import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { expect, test } from 'vite-plus/test'
import {
	relationshipStressFixture,
	seedRelationshipStress,
} from './fixture-querying/relationships-stress'

// Nearest-rank percentiles; small samples have a p99 equal to their maximum.
function latencySummary(samples: readonly number[]) {
	const sorted = [...samples].sort((a, b) => a - b)
	const percentile = (p: number) => sorted[Math.ceil((p / 100) * sorted.length) - 1]
	return {
		samples: sorted.length,
		unit: 'milliseconds',
		method: 'nearest-rank',
		p10: percentile(10),
		p50: percentile(50),
		p99: percentile(99),
	}
}

test('U6 source engine full v3 stress sequences match independent ordered ID hashes and duplicate output', async () => {
	const started = performance.now()
	const oracle = z
		.object({
			counts: z.object({ tasks: z.number(), labels: z.number(), junctions: z.number() }),
			visibleDuplicateParents: z.array(z.number()),
			expected: z.record(
				z.string(),
				z.object({ asc: z.array(z.number()), desc: z.array(z.number()) }),
			),
		})
		.parse(
			JSON.parse(
				readFileSync(
					new URL('./fixture-querying/relationships-stress-oracle-v3.json', import.meta.url),
					'utf8',
				),
			),
		)
	expect(oracle.counts).toEqual({ tasks: 2200, labels: 80, junctions: 11100 })
	expect(oracle.visibleDuplicateParents).toHaveLength(49)
	const f = relationshipStressFixture(),
		ids = await seedRelationshipStress(f)
	console.info(JSON.stringify({ phase: 'seed', milliseconds: performance.now() - started }))
	type Args = Parameters<ReturnType<typeof f.querying>['tasks']['paginate']>[0]
	const cases = {
		department_status_active: { tenant: 'a', department: 'support', status: 'open', active: true },
		range_and_not: { priority: { gte: 1, lt: 4 }, not: { status: 'blocked' } },
		or_common_department: {
			tenant: 'a',
			department: 'support',
			or: [{ active: true }, { priority: 3 }],
		},
		or_no_common_binding: { or: [{ department: 'support' }, { status: 'done' }] },
		some_shared_label: { labels: { some: { ordinal: 17 } } },
		none_visible_label: { labels: { none: { ordinal: 17 } } },
		no_authorized_related_target: { labels: { none: {} } },
	} satisfies Record<string, Args['filters']>
	const hash = (values: readonly string[]) =>
		createHash('sha256').update(JSON.stringify(values)).digest('hex')
	for (const [name, filters] of Object.entries(cases))
		for (const order of ['asc', 'desc'] as const)
			for (const size of [1, 7, 25, 100]) {
				const caseStarted = performance.now()
				const actual: string[] = []
				const pageLatencies: number[] = []
				let cursor: string | null = null
				const counters = { next: 0, returned: 0, ranges: 0, gets: 0, closes: 0 }
				for (let page = 0; page < 2500; page++) {
					const pageStarted = performance.now()
					const result = await f.t.run(async (ctx) => {
						const o = f.context(ctx.db)
						const result = await f
							.querying(o.ctx)
							.tasks.paginate({ numItems: size, cursor, order, filters })
						for (const key of ['next', 'returned', 'ranges', 'gets', 'closes'] as const)
							counters[key] += o.counts[key]
						expect(o.counts.closes).toBe(o.counts.ranges)
						return result
					})
					pageLatencies.push(performance.now() - pageStarted)
					actual.push(...result.page.map((t) => t._id))
					if (result.isDone) break
					expect(result.continueCursor).not.toBe(cursor)
					cursor = result.continueCursor
					expect(page).toBeLessThan(2499)
				}
				const expected = oracle.expected[name][order].map((i) => ids.tasks[i])
				expect(actual).toEqual(expected)
				expect(hash(actual)).toBe(hash(expected))
				console.info(
					JSON.stringify({
						scope: 'U6 source imports / convex-test application-helper accounting',
						name,
						order,
						size,
						milliseconds: performance.now() - caseStarted,
						count: actual.length,
						idHash: hash(actual),
						counters,
						pageLatency: latencySummary(pageLatencies),
					}),
				)
			}
	const childPageLatencies: number[] = []
	for (const ordinal of oracle.visibleDuplicateParents)
		for (const order of ['asc', 'desc'] as const) {
			const expectedOrdinals = Array.from({ length: 5 }, (_, j) => ({
				label: (ordinal + j * 17) % 80,
				allowed: ordinal % 37 !== 0 && (ordinal + j) % 13 !== 0,
			}))
			expectedOrdinals.push({ label: (ordinal + 17) % 80, allowed: true })
			const expected = expectedOrdinals
				.filter((e) => e.allowed && e.label % 5 !== 0 && e.label % 7 !== 0)
				.map((e) => ids.labels[e.label])
			if (order === 'desc') expected.reverse()
			const actual: string[] = []
			let cursor: string | null = null
			for (let page = 0; page < 20; page++) {
				const pageStarted = performance.now()
				const result = await f.t.run((ctx) =>
					f
						.querying(f.context(ctx.db).ctx)
						.tasks.relation(ids.tasks[ordinal], 'labels')
						.paginate({ numItems: 1, cursor, order }),
				)
				childPageLatencies.push(performance.now() - pageStarted)
				actual.push(...result.page.map((l) => l._id))
				if (result.isDone) break
				cursor = result.continueCursor
				expect(page).toBeLessThan(19)
			}
			expect(actual).toEqual(expected)
			expect(new Set(actual).size).toBeLessThan(actual.length)
		}
	console.info(
		JSON.stringify({
			scope: 'U6 source imports / convex-test application-helper accounting',
			name: 'duplicate_child_continuations',
			pageLatency: latencySummary(childPageLatencies),
		}),
	)
	// The full matrix takes over twelve minutes on GitHub's shared Linux runners.
	// Keep every oracle and duplicate-output assertion with a bounded CI allowance.
}, 1800000)
