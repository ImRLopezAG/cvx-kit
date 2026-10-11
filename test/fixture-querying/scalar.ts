import { z } from 'zod'
import {
	defineSchema,
	type DataModelFromSchemaDefinition,
	type GenericDatabaseReader,
	type QueryInitializer,
	type GenericDataModel,
	type GenericTableInfo,
} from 'convex/server'
import { defineTestApp } from 'convex-test'
import { zodTable } from '../../src/zod-table'
import { defineRelations } from '../../src/relations'
import {
	registerQueryReader,
	type ManagedScope,
	type SecurityPolicyContext,
} from '../../src/querying/security'
import type { Rules } from '../../src/tenancy'
import { createQueryEngine } from '../../src/querying'

export function declarations() {
	const tasks = zodTable(
		'tasks',
		(id) => ({
			ordinal: z.number(),
			department: z.string(),
			status: z.string(),
			active: z.boolean(),
			count: z.number(),
			code: z.string(),
			optional: z.string().nullable().optional(),
			big: z.bigint(),
			reference: id('tasks').nullable(),
			permission: id('permissions').optional(),
			tenant: z.string(),
			secret: z.string(),
		}),
		{ publicFields: ['ordinal', 'department', 'status'] },
	)
	const nativeTasks = tasks.table
		.index('by_department_count', ['department', 'count'])
		.index('by_status', ['status'])
		.index('by_active', ['active'])
		.index('by_count', ['count'])
		.index('by_code', ['code'])
		.index('by_department', ['department'])
	const permissions = zodTable('permissions', () => ({ allowed: z.boolean(), tenant: z.string() }))
	const relations = defineRelations({ tasks, permissions }, (r) => ({
		tasks: { referenceTask: r.one.tasks({ from: r.tasks.reference, to: r.tasks._id }) },
	}))
	const schema = defineSchema({ tasks: nativeTasks, permissions: permissions.table })
	return { tasks, permissions, relations, schema }
}
export type Fixture = ReturnType<typeof declarations>
export type DM = DataModelFromSchemaDefinition<Fixture['schema']>
export const scope: ManagedScope = {
	mode: 'authenticated',
	principal: 'user',
	tenant: 'one',
	organization: 'one',
	role: 'reader',
}
export const cursor = {
	version: 'v1',
	currentKeyId: 'test',
	keys: { test: new Uint8Array(64).fill(7) },
}

/** Public native queries are instrumented without implementing ordering or pagination. */
export function observed<Model extends GenericDataModel>(reader: GenericDatabaseReader<Model>) {
	const counts = { next: 0, returned: 0, ranges: 0, gets: 0, closes: 0 }
	function query<T extends GenericTableInfo>(source: QueryInitializer<T>): QueryInitializer<T> {
		return new Proxy(source, {
			get(target, key) {
				if (key === Symbol.asyncIterator)
					return () => {
						counts.ranges++
						const inner = target[Symbol.asyncIterator]()
						return {
							next: async () => {
								counts.next++
								const row = await inner.next()
								if (!row.done) counts.returned++
								return row
							},
							return: async () => {
								counts.closes++
								return inner.return ? inner.return() : { done: true as const, value: undefined }
							},
						}
					}
				// SAFETY: native fluent method names are selected below; instrumentation preserves their source.
				if (['withIndex', 'order', 'fullTableScan'].includes(String(key)))
					return (...args: never[]) => {
						// SAFETY: these three native fluent methods return real queries; proxy instrumentation does not reinterpret them.
						const fluent = target[key as 'withIndex' | 'order' | 'fullTableScan'] as (
							...args: never[]
						) => QueryInitializer<T>
						return query(fluent.apply(target, args))
					}
				// SAFETY: proxy keys are forwarded without interpreting or synthesizing values.
				const value = target[key as keyof QueryInitializer<T>]
				return value instanceof Function ? value.bind(target) : value
			},
		})
	}
	const raw: GenericDatabaseReader<Model> = {
		...reader,
		get: (...args: Parameters<typeof reader.get>) => {
			counts.gets++
			return reader.get(...args)
		},
		query: (table) => query(reader.query(table)),
		normalizeId: reader.normalizeId.bind(reader),
		system: reader.system,
	}
	return { raw, counts }
}
export function managed<Model extends GenericDataModel>(
	reader: GenericDatabaseReader<Model>,
	rules: Rules<SecurityPolicyContext<Model>, Model> = {},
	defaultPolicy: 'allow' | 'deny' = 'allow',
	authority = scope,
) {
	return { db: registerQueryReader(reader, reader, { scope: authority, rules, defaultPolicy }) }
}
export function harness() {
	const f = declarations()
	const { createTest } = defineTestApp({ schema: f.schema }).defineModules({})
	return {
		...f,
		t: createTest(),
		querying: createQueryEngine({ schema: f.schema, relations: f.relations, cursor }),
	}
}
export async function seed(f: Pick<ReturnType<typeof harness>, 't'>, size = 24, denied = 0) {
	return f.t.run(async (ctx) => {
		const rows = []
		for (let ordinal = 0; ordinal < size; ordinal++) {
			const id = await ctx.db.insert('tasks', {
				ordinal,
				department: ordinal % 3 ? 'a' : 'b',
				status: ordinal % 2 ? 'open' : 'done',
				active: ordinal % 2 === 0,
				count: ordinal % 4,
				code: ordinal % 2 ? 'x' : '',
				...(ordinal % 3 === 1 ? { optional: null } : ordinal % 3 === 2 ? { optional: '' } : {}),
				big: BigInt(ordinal),
				reference: null,
				tenant: ordinal < denied ? 'two' : 'one',
				secret: 'private',
			})
			rows.push((await ctx.db.get(id))!)
		}
		return rows
	})
}
