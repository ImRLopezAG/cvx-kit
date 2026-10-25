import { expect, test } from 'vite-plus/test'
import { QueryStream, type IndexBounds, type IndexKey } from 'convex-helpers/server/stream'
import type { Value } from 'convex/values'
import { executeStream } from '../src/querying/execution'
import { createPlanner } from '../src/querying/planner'
import { createCursorCodec, type CursorBinding } from '../src/querying/cursors'
import { createManagedSecurity, ManagedReadError } from '../src/querying/security'
import { harness, seed, managed, cursor, type DM } from './fixture-querying/scalar'

/** A transformed source can throw without consuming another raw candidate. */
class FailingSource extends QueryStream<Record<string, Value>> {
	constructor(private readonly source: QueryStream<Record<string, Value>>) {
		super()
	}
	getOrder() {
		return this.source.getOrder()
	}
	getIndexFields() {
		return this.source.getIndexFields()
	}
	getEqualityIndexFilter() {
		return this.source.getEqualityIndexFilter()
	}
	narrow(bounds: IndexBounds) {
		return new FailingSource(this.source.narrow(bounds))
	}
	async *iterWithKeys(): AsyncGenerator<
		[Record<string, Value> | null, IndexKey, number],
		undefined
	> {
		for await (const entry of this.source.iterWithKeys()) {
			yield entry
			throw new ManagedReadError('MANAGED_READ_BUDGET')
		}
	}
}

test('U3 arbitrary nested budget faults after completed progress remain failures', async () => {
	const f = harness()
	await seed(f, 3)
	const planner = createPlanner(f.schema, f.relations)
	const codec = createCursorCodec(cursor)
	const binding: CursorBinding = {
		table: 'tasks',
		order: 'asc',
		clientFilters: {},
		serverFilters: {},
		relationPath: [],
		principal: 'user',
		policyVersion: '1',
		engineVersion: '1',
		registryVersion: '1',
	}
	const security = createManagedSecurity<DM>({
		tables: ['tasks', 'permissions'],
		policyVersion: '1',
	})
	for (const onEmptyBudget of [undefined, 'split'] as const)
		await f.t.run(async (ctx) => {
			const plan = planner.plan('tasks', { numItems: 10, cursor: null }, [], [])
			const request = security(managed<DM>(ctx.db))
			await expect(
				executeStream(
					f.schema,
					request,
					'tasks',
					plan,
					planner,
					codec,
					binding,
					{ ...plan.args, onEmptyBudget },
					undefined,
					undefined,
					(source) => new FailingSource(source),
				),
			).rejects.toThrow('MANAGED_READ_BUDGET')
		})
})
