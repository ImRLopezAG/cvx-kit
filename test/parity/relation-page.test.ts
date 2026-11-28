// A relation page of 25 rows, its continuation, a root page with a nested relation page and a
// filtered page return the same rows and the same sealed cursors as v1 did for the same data.
// The snapshot was recorded from the v1 (Zod) engine at the commit before U13, with the same
// scenario declared through zodTable; equal cursors also prove equal registry identity bytes.
import { readFileSync } from 'node:fs'
import { defineSchema } from 'convex/server'
import { defineTestApp } from 'convex-test'
import { expect, test } from 'vite-plus/test'
import { k } from '../../src/k'
import { createQueryEngine } from '../../src/querying'
import { defineRelations } from '../../src/relations'
import { kTable } from '../../src/table'
import { cursor, managed } from '../fixture-querying/scalar'

test('v2 relation pages match the v1 rows and cursors', async () => {
	const parents = kTable('parents', { name: k.string() }, { publicFields: ['name'] })
	const children = kTable(
		'children',
		{ parentId: k.id('parents'), rank: k.number(), label: k.string() },
		{ publicFields: ['rank', 'label'] },
	)
	const relations = defineRelations({ parents, children }, (r) => ({
		parents: { children: r.many.children({ from: r.parents._id, to: r.children.parentId }) },
		children: { parent: r.one.parents({ from: r.children.parentId, to: r.parents._id }) },
	}))
	const schema = defineSchema({
		parents: parents.table,
		children: children.table.index('by_parentId', ['parentId']),
	})
	const t = defineTestApp({ schema }).defineModules({}).createTest()
	const querying = createQueryEngine({ schema, relations, cursor })
	const original = Date.now
	Date.now = () => 2 ** 44
	try {
		const result = await t.run(async (ctx) => {
			const parent = await ctx.db.insert('parents', { name: 'p' })
			for (let rank = 0; rank < 30; rank++)
				await ctx.db.insert('children', { parentId: parent, rank, label: `c${rank}` })
			const q = querying(managed(ctx.db))
			const first = await q.parents
				.relation(parent, 'children')
				.paginate({ numItems: 25, cursor: null })
			const second = await q.parents
				.relation(parent, 'children')
				.paginate({ numItems: 25, cursor: first.continueCursor })
			const nested = await q.parents
				.with({ children: true })
				.paginate({ numItems: 1, cursor: null })
			const filtered = await q.children.paginate({
				numItems: 25,
				cursor: null,
				filters: { rank: { gte: 3 } },
			})
			return { parent, first, second, nested, filtered }
		})
		expect(result.first.page).toHaveLength(25)
		const recorded = JSON.parse(
			readFileSync(new URL('./v1-relation-page.snapshot.json', import.meta.url), 'utf8'),
		)
		expect(JSON.parse(JSON.stringify(result))).toEqual(recorded)
	} finally {
		Date.now = original
	}
})
