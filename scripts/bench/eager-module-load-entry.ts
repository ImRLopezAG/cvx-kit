// Eager consumer: module-level schemas, native table maps and API contract reads.
// Shares the table/edge workload with the deferred module-load fixture.
// The v1 (Zod) twin is this file at commit 8d979a5: `z.strictObject` becomes
// `k.object`, `.refine(() => true)` becomes `.refine(() => true)` and
// `z.toJSONSchema(s, { io: 'input' })` becomes `toJsonSchema(s)`, so the
// snapshot is compared between cases of one kit version, not across versions.
import { defineSchema } from 'convex/server'
import { k, type KType } from '../../src/k'
import { KObject } from '../../src/k/object'
import { toJsonSchema } from '../../src/json-schema'
import { createModule } from '../../src/namespace'
import { defineDomainContract } from '../../src/contracts'
import { defineTables, register } from '../../test/fixture-querying/bench-relations'

declare const __CVX_BENCH_LAZY_CONTRACTS__: boolean

const start = performance.now()
export const tables = defineTables(true)
const declared = performance.now()
// Cross-domain DTOs commonly use another table's document ID at module scope.
export const references: Record<string, KObject<{ targetId: KType }>> = {}
for (const [name, boundary] of Object.entries(tables.tables)) {
	const schema = boundary.schema
	if (schema instanceof KObject) {
		references[name] = k.object({ targetId: schema.shape._id })
	}
}
export const domains = Object.fromEntries(
	Object.entries(tables.entities).map(([name, boundary]) => [
		name,
		{
			detail: boundary.publicDto.extend({ label: k.string() }),
			command: boundary.commandInput.refine(() => true),
			update: boundary.updateSchema,
			tools: boundary.tools,
		},
	]),
)
export const detail = tables.tables.tasks.publicDto.extend({
	owner: tables.tables.entity0.publicDto,
})
export const command = tables.tables.tasks.commandInput.refine(() => true)
export const update = tables.tables.tasks.updateSchema
export const tools = tables.tables.tasks.tools
export const native = defineSchema(
	createModule(
		Object.fromEntries(Object.entries(tables.tables).map(([name, t]) => [name, t.table])),
	),
)
const composed = performance.now()
export const relations = register(tables)
const registered = performance.now()
export const contracts = Array.from({ length: 30 }, (_, index) => {
	const name: `entity${number}` = `entity${index}`
	const build = () => ({
		queries: {
			list: {
				input: tables.tables[name].paginationOpts({ status: true, rank: true }),
				result: relations.tables[name].pageDto({}),
			},
		},
	})
	return defineDomainContract(__CVX_BENCH_LAZY_CONTRACTS__ ? build : build())
})
// API declaration consumes every contract at import, including the thunk form.
export const api = contracts.map((contract) => ({
	args: contract.queries.list.input,
	returns: contract.queries.list.result,
}))
const contracted = performance.now()
export const timings = {
	tables: declared - start,
	composition: composed - declared,
	defineRelations: registered - composed,
	contracts: contracted - registered,
}
// Compare complete schema descriptions and representative validation outputs
// outside the timed import. The harness rejects any cross-version difference.
export function snapshot() {
	const args = { numItems: 2, cursor: null, filters: { status: 'open', rank: { gte: 1 } } }
	const row = {
		ref: 'R',
		ordinal: 1,
		status: 'open',
		title: 'Title',
		active: true,
		rank: 2,
		code: 'C',
		tags: ['tag'],
		details: { text: 'detail' },
	}
	const commandValue = { ref: row.ref, status: row.status, title: row.title }
	return {
		native: JSON.stringify(native),
		domains: Object.fromEntries(
			Object.entries(domains).map(([key, domain]) => [
				key,
				{
					detail: toJsonSchema(domain.detail),
					parsedDetail: domain.detail.parse({ ...row, label: 'Label' }),
					parsedCommand: domain.command.parse(commandValue),
					parsedUpdate: domain.update.parse({ title: 'Changed' }),
					parsedToolInsert: domain.tools.insert.parse(commandValue),
					parsedToolUpdate: domain.tools.update.parse({
						id: `${key}:1`,
						data: { title: 'Changed' },
					}),
					command: toJsonSchema(domain.command),
					update: toJsonSchema(domain.update),
					tools: Object.fromEntries(
						Object.entries(domain.tools).map(([name, schema]) => [name, toJsonSchema(schema)]),
					),
				},
			]),
		),
		references: Object.fromEntries(
			Object.entries(references).map(([key, schema]) => [
				key,
				{
					json: toJsonSchema(schema),
					parsed: schema.parse({ targetId: `${key}:1` }),
					invalid: schema.safeParse({ targetId: 42 }).success,
				},
			]),
		),
		detail: toJsonSchema(detail),
		command: toJsonSchema(command),
		update: toJsonSchema(update),
		tools: Object.fromEntries(
			Object.entries(tools).map(([key, schema]) => [key, toJsonSchema(schema)]),
		),
		api: api.map(({ args: input, returns: output }, index) => {
			const page = { page: [{ ...row, _id: `entity${index}:1` }], isDone: true, continueCursor: '' }
			return {
				input: toJsonSchema(input),
				output: toJsonSchema(output),
				parsedInput: input.parse(args),
				parsedOutput: output.parse(page),
				invalidInput: input.safeParse({ ...args, filters: { internal: 'secret' } }).success,
				invalidOutput: output.safeParse({
					...page,
					page: [{ ...row, _id: `entity${index}:1`, internal: 'secret' }],
				}).success,
			}
		}),
	}
}
