import { expect, test } from 'vite-plus/test'
import { stream } from 'convex-helpers/server/stream'
import type {
	DataModelFromSchemaDefinition,
	GenericDatabaseReader,
	SchemaDefinition,
	TableDefinition,
} from 'convex/server'
import { createCursorCodec, type CursorBinding } from '../src/querying/cursors'
import { getRelationExecutor } from '../src/relations'
import { cursor, scope } from './fixture-querying/scalar'
import { relationshipFixture, seedRelationships } from './fixture-querying/relationships'

for (const name of ['direct', 'labels'] as const)
	for (const order of ['asc', 'desc'] as const)
		test(`0.1.17 ${name} child cursor resumes in the current engine (${order}) and reauthorizes`, async () => {
			const f = relationshipFixture()
			const rows = await seedRelationships(f)
			const parent = rows.tasks[1]._id
			const authority = { ...scope, policyVersion: '1' }
			const registryVersion = Array.from(
				new Uint8Array(
					await crypto.subtle.digest('SHA-256', new TextEncoder().encode(f.relations.identity)),
				),
				(byte) => byte.toString(16).padStart(2, '0'),
			).join('')
			// Exact base 9121d5e relationships.prepare + querying.paginate binding:
			// no filters/constraints/selection, unguarded scalar or ID junction lookup.
			// Deliberately independent of the current engine's binding/prepare implementation.
			const binding: CursorBinding = {
				table: name === 'direct' ? 'labels' : 'edges',
				index: 'by_task',
				order,
				clientFilters: {
					kind: 'and',
					children: [
						{ kind: 'and', children: [] },
						{ kind: 'and', children: [] },
					],
				},
				serverFilters: {
					predicates: {
						kind: 'and',
						children: [
							{ kind: 'and', children: [] },
							{ kind: 'and', children: [] },
						],
					},
					selection: {},
					scope: authority,
					rootTable: 'tasks',
					lookupIndex: name === 'direct' ? 'by_task' : 'by_id',
					guards: { source: null, target: null, junction: null },
				},
				relationPath: [name],
				parent,
				principal: JSON.stringify(authority),
				tenant: scope.tenant,
				policyVersion: '1',
				engineVersion: 'scalar-1',
				registryVersion,
			}
			const codec = createCursorCodec(cursor)
			const scoped: CursorBinding = {
				...binding,
				registryVersion: Array.from(
					new Uint8Array(
						await crypto.subtle.digest(
							'SHA-256',
							new TextEncoder().encode(
								getRelationExecutor(f.relations).scopedIdentity(['tasks'], [['tasks', name]]),
							),
						),
					),
					(byte) => byte.toString(16).padStart(2, '0'),
				).join(''),
			}
			// SAFETY: relationshipFixture registers both by_task indexes in place,
			// which preserves their runtime descriptors but loses the fluent return types.
			const nativeSchema = f.schema as SchemaDefinition<
				{
					tasks: typeof f.tasks.table
					labels: TableDefinition<
						typeof f.labels.table.validator,
						{ by_task: ['task', '_creationTime'] }
					>
					edges: TableDefinition<
						typeof f.edges.table.validator,
						{ by_task: ['task', '_creationTime'] }
					>
				},
				true
			>
			const first = await f.t.run(async (ctx) => {
				// SAFETY: this is the same fixture reader; only its erased registered
				// index types are restored, with unchanged document and ID types.
				const native = ctx.db as GenericDatabaseReader<
					DataModelFromSchemaDefinition<typeof nativeSchema>
				>
				const page =
					name === 'direct'
						? await stream(native, nativeSchema)
								.query('labels')
								.withIndex('by_task', (q) => q.eq('task', parent))
								.order(order)
								.filterWith(async (row) => row.allowed && row.tenant === 'one')
								.paginate({ numItems: 1, cursor: null })
						: await stream(native, nativeSchema)
								.query('edges')
								.withIndex('by_task', (q) => q.eq('task', parent))
								.order(order)
								.filterWith(async (row) => {
									const target = await ctx.db.get(row.label)
									return row.allowed && !!target && target.allowed && target.tenant === 'one'
								})
								.paginate({ numItems: 1, cursor: null })
				expect(page.isDone).toBe(false)
				return {
					ids: page.page.map((row) => ('label' in row ? row.label : row._id)),
					token: codec.seal(
						JSON.stringify({ cursor: page.continueCursor, ancestors: [] }),
						binding,
					),
				}
			})
			const expected =
				name === 'direct'
					? rows.labels.filter((row) => row.allowed && row.tenant === 'one').map((row) => row._id)
					: rows.edges
							.filter((row) => row.task === parent && row.allowed)
							.flatMap((edge) =>
								rows.labels
									.filter((row) => row._id === edge.label && row.allowed && row.tenant === 'one')
									.map((row) => row._id),
							)
			if (order === 'desc') expected.reverse()
			const actual = [...first.ids]
			let token = first.token
			let done = false
			for (let page = 0; page < 10 && !done; page++) {
				const next = await f.t.run(async (ctx) => {
					const o = f.context(ctx.db)
					const result = await f
						.querying(o.ctx)
						.tasks.relation(parent, name)
						.paginate({ numItems: page % 2 ? 2 : 1, cursor: token, order })
					expect(o.counts.closes).toBe(o.counts.ranges)
					expect(o.counts.gets).toBeGreaterThan(0)
					return result
				})
				actual.push(...next.page.map((row) => row._id))
				// Subsequent current-engine tokens also retain the legacy authenticated binding.
				// Continuations reseal under the 0.1.25 digest of the child path's scope.
				expect(JSON.parse(codec.open(next.continueCursor, scoped))).toHaveProperty('ancestors', [])
				expect(() => codec.open(next.continueCursor, binding)).toThrow('Invalid cursor')
				if (!next.isDone) expect(next.continueCursor).not.toBe(token)
				token = next.continueCursor
				done = next.isDone
			}
			expect(done).toBe(true)
			expect(actual).toEqual(expected)
			// Replay the same authentic legacy token after target/junction authorization changes.
			const revoked = expected.at(-1)!
			await f.t.run((ctx) => ctx.db.patch(revoked, { allowed: false }))
			const afterRevocation = await f.t.run((ctx) =>
				f
					.querying(f.context(ctx.db).ctx)
					.tasks.relation(parent, name)
					.paginate({ numItems: 100, cursor: first.token, order }),
			)
			expect(afterRevocation.page.map((row) => row._id)).toEqual(
				expected.slice(1).filter((id) => id !== revoked),
			)
			if (name === 'labels') {
				await f.t.run(async (ctx) => {
					for (const edge of rows.edges.filter((row) => row.task === parent))
						await ctx.db.patch(edge._id, { allowed: false })
				})
				const denied = await f.t.run((ctx) =>
					f
						.querying(f.context(ctx.db).ctx)
						.tasks.relation(parent, name)
						.paginate({ numItems: 100, cursor: first.token, order }),
				)
				expect(denied.page).toEqual([])
				expect(denied.isDone).toBe(true)
			}
			await f.t.run((ctx) => ctx.db.patch(parent, { allowed: false }))
			const deniedParent = await f.t.run(async (ctx) => {
				const o = f.context(ctx.db)
				const page = await f
					.querying(o.ctx)
					.tasks.relation(parent, name)
					.paginate({ numItems: 100, cursor: first.token, order })
				expect(o.counts.next).toBe(0)
				return page
			})
			expect(deniedParent.page).toEqual([])
			expect(deniedParent.isDone).toBe(true)
		})
