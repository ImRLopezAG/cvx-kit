import { Effect } from 'effect'
import { convexTest } from 'convex-test'
import {
	defineSchema,
	defineTable,
	type DataModelFromSchemaDefinition,
	type GenericMutationCtx,
} from 'convex/server'
import { v } from 'convex/values'
import { describe, expect, it } from 'vite-plus/test'
import { k } from '../src/k'
import { createEffectFoundation } from '../src/modules/effect/foundation'
import type { RequestScope } from '../src/modules/effect/scope'

const schema = defineSchema({
	audits: defineTable({ operation: v.string() }),
	writes: defineTable({ kind: v.string() }),
})
type Host = GenericMutationCtx<DataModelFromSchemaDefinition<typeof schema>>
const modules = import.meta.glob('./fixture/**/*.ts')

function setup(nestedAudit: 'fold' | 'separate' = 'fold') {
	const scopes = new Map<string, RequestScope | undefined>()
	const auditCalls: string[] = []
	const foundation = createEffectFoundation({
		observability: {
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'FAILURE' }),
		},
		writeAudit: (host: Host, entry) =>
			host.db.insert('audits', { operation: entry.operation }).then(() => undefined),
		nestedAudit,
	})
	const inner = foundation.Command({
		context: (host: Host) => ({ host }),
		operations: ({ command }) => ({
			'inner.touch': command({
				input: k.string(),
				result: k.string(),
				classification: 'business',
				audit: (_resolution, _context, scope) => {
					auditCalls.push('inner.touch')
					scopes.set('inner.touch', scope)
					return { operation: 'inner.touch', actorId: 'u', aggregate: { type: 'x', id: '1' } }
				},
				handler: async (input, ctx) => {
					await ctx.host.db.insert('writes', { kind: input })
					return input
				},
			}),
		}),
	})
	const outer = foundation.Command({
		context: (host: Host) => ({ host, inner: inner.withContext(host) }),
		operations: ({ command }) => ({
			'outer.run': command({
				input: k.string(),
				result: k.string(),
				classification: 'business',
				audit: (_resolution, _context, scope) => {
					auditCalls.push('outer.run')
					scopes.set('outer.run', scope)
					return { operation: 'outer.run', actorId: 'u', aggregate: { type: 'x', id: '1' } }
				},
				handler: (input, ctx) => ctx.inner.exec('inner.touch', input),
			}),
			'outer.bridge': command({
				input: k.string(),
				result: k.string(),
				classification: 'business',
				audit: () => ({
					operation: 'outer.bridge',
					actorId: 'u',
					aggregate: { type: 'x', id: '1' },
				}),
				handler: (input, ctx) => Effect.runPromise(ctx.inner.exec('inner.touch', input)),
			}),
		}),
	})
	const queries = foundation.Query({
		context: (host: Host) => ({ inner: inner.withContext(host) }),
		operations: ({ query }) => ({
			'query.wrap': query({
				input: k.string(),
				result: k.string(),
				handler: (input, ctx) => ctx.inner.exec('inner.touch', input),
			}),
		}),
	})
	return { outer, inner, queries, scopes, auditCalls }
}

async function audits(t: ReturnType<typeof convexTest>) {
	return (await t.run((ctx) => ctx.db.query('audits').collect())).map((row) => row.operation)
}

describe('request scope', () => {
	it('folds nested audit into the auditing ancestor by default', async () => {
		const h = setup()
		const t = convexTest(schema, modules)
		await t.mutation((host) => Effect.runPromise(h.outer.exec('outer.run', 'a', host)))
		expect(await audits(t)).toEqual(['outer.run'])
		expect(h.auditCalls).toEqual(['outer.run'])
		expect(h.scopes.get('outer.run')).toBeUndefined()
		expect(await t.run((ctx) => ctx.db.query('writes').collect())).toHaveLength(1)
	})

	it('keeps per-operation entries in separate mode and passes the entered scope', async () => {
		const h = setup('separate')
		const t = convexTest(schema, modules)
		await t.mutation((host) => Effect.runPromise(h.outer.exec('outer.run', 'a', host)))
		expect((await audits(t)).sort()).toEqual(['inner.touch', 'outer.run'])
		expect(h.scopes.get('inner.touch')).toEqual({
			root: 'outer.run',
			parent: 'outer.run',
			depth: 1,
		})
		expect(h.scopes.get('outer.run')).toBeUndefined()
	})

	it('treats sequential top-level executions as separate roots', async () => {
		const h = setup()
		const t = convexTest(schema, modules)
		await t.mutation((host) =>
			Effect.runPromise(
				Effect.gen(function* () {
					yield* h.outer.exec('outer.run', 'a', host)
					yield* h.inner.exec('inner.touch', 'b', host)
					const effect = h.inner.exec('inner.touch', 'c', host)
					yield* effect
					yield* effect
				}),
			),
		)
		expect((await audits(t)).sort()).toEqual([
			'inner.touch',
			'inner.touch',
			'inner.touch',
			'outer.run',
		])
	})

	it('audits a nested command whose ancestors declare no audit', async () => {
		const h = setup()
		const t = convexTest(schema, modules)
		await t.mutation((host) => Effect.runPromise(h.queries.exec('query.wrap', 'a', host)))
		expect(await audits(t)).toEqual(['inner.touch'])
		expect(h.scopes.get('inner.touch')).toEqual({
			root: 'query.wrap',
			parent: 'query.wrap',
			depth: 1,
		})
	})

	it('passes the entered scope to registry-level audit callbacks', async () => {
		const seen: unknown[] = []
		const foundation = createEffectFoundation({
			observability: {
				enabled: false,
				classifyError: () => ({ outcome: 'failed', errorCode: 'F' }),
			},
			writeAudit: () => undefined,
			nestedAudit: 'separate',
		})
		const leaf = foundation.Command({
			context: () => ({}),
			audit: ({ operation }, _context, scope) => {
				seen.push({ operation, scope })
				return null
			},
			operations: ({ command }) => ({
				'leaf.ping': command({
					input: k.number(),
					result: k.number(),
					classification: 'business',
					handler: (n) => n,
				}),
			}),
		})
		const root = foundation.Command({
			context: () => ({ leaf: leaf.withContext(undefined) }),
			operations: ({ command }) => ({
				'root.call': command({
					input: k.number(),
					result: k.number(),
					classification: 'business',
					audit: () => null,
					handler: (n, ctx) => Effect.map(ctx.leaf.exec('leaf.ping', n), Number),
				}),
			}),
		})
		expect(await Effect.runPromise(root.exec('root.call', 2, undefined))).toBe(2)
		expect(seen).toEqual([
			{ operation: 'leaf.ping', scope: { root: 'root.call', parent: 'root.call', depth: 1 } },
		])
	})

	it('starts a new root across a Promise bridge', async () => {
		const h = setup()
		const t = convexTest(schema, modules)
		await t.mutation((host) => Effect.runPromise(h.outer.exec('outer.bridge', 'a', host)))
		expect((await audits(t)).sort()).toEqual(['inner.touch', 'outer.bridge'])
	})
})
