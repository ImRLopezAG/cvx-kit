// Eager consumer: module-level schemas, native table maps and API contract reads.
// Shares the table/edge workload with the deferred module-load fixture.
import { z } from 'zod'
import { defineSchema } from 'convex/server'
import { createModule } from '../../src/zod-table'
import { defineDomainContract } from '../../src/contracts'
import { defineTables, register } from './relations-fixture'

declare const __CVX_BENCH_LAZY_CONTRACTS__: boolean

const start = performance.now()
export const tables = defineTables(true)
const declared = performance.now()
// Cross-domain DTOs commonly use another table's document ID at module scope.
export const references: Record<string, z.ZodObject<{ targetId: z.ZodType }>> = {}
for (const [name, boundary] of Object.entries(tables.tables)) {
	const schema = boundary.schema
	if (schema instanceof z.ZodObject) {
		references[name] = z.strictObject({ targetId: schema.shape._id })
	}
}
export const domains = Object.fromEntries(
	Object.entries(tables.entities).map(([name, boundary]) => [
		name,
		{
			detail: boundary.publicDto.extend({ label: z.string() }),
			command: boundary.commandInput.superRefine(() => {}),
			update: boundary.updateSchema,
			tools: boundary.tools,
		},
	]),
)
export const detail = tables.tables.tasks.publicDto.extend({
	owner: tables.tables.entity0.publicDto,
})
export const command = tables.tables.tasks.commandInput.superRefine(() => {})
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
	zodTables: declared - start,
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
					detail: z.toJSONSchema(domain.detail, { io: 'input', unrepresentable: 'any' }),
					parsedDetail: domain.detail.parse({ ...row, label: 'Label' }),
					parsedCommand: domain.command.parse(commandValue),
					parsedUpdate: domain.update.parse({ title: 'Changed' }),
					parsedToolInsert: domain.tools.insert.parse(commandValue),
					parsedToolUpdate: domain.tools.update.parse({
						id: `${key}:1`,
						data: { title: 'Changed' },
					}),
					command: z.toJSONSchema(domain.command, { io: 'input', unrepresentable: 'any' }),
					update: z.toJSONSchema(domain.update, { io: 'input', unrepresentable: 'any' }),
					tools: Object.fromEntries(
						Object.entries(domain.tools).map(([name, schema]) => [
							name,
							z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
						]),
					),
				},
			]),
		),
		references: Object.fromEntries(
			Object.entries(references).map(([key, schema]) => [
				key,
				{
					json: z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
					parsed: schema.parse({ targetId: `${key}:1` }),
					invalid: schema.safeParse({ targetId: 42 }).success,
				},
			]),
		),
		detail: z.toJSONSchema(detail, { io: 'input', unrepresentable: 'any' }),
		command: z.toJSONSchema(command, { io: 'input', unrepresentable: 'any' }),
		update: z.toJSONSchema(update, { io: 'input', unrepresentable: 'any' }),
		tools: Object.fromEntries(
			Object.entries(tools).map(([key, schema]) => [
				key,
				z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
			]),
		),
		api: api.map(({ args: input, returns: output }, index) => {
			const page = { page: [{ ...row, _id: `entity${index}:1` }], isDone: true, continueCursor: '' }
			return {
				input: z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' }),
				output: z.toJSONSchema(output, { io: 'input', unrepresentable: 'any' }),
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
