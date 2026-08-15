import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'

import { createAgentTools } from '../src/agent-tools'
import { zodTable } from '../src/zod-table'

const documents = zodTable(
	'documents',
	(id) => ({
		title: z.string(),
		ownerId: id('users'),
		secretNote: z.string(),
	}),
	{ commandFields: ['title'] },
)

describe('createAgentTools', () => {
	it('reuses the table tool masks with no drift', () => {
		const tools = createAgentTools(documents, {
			create: async () => null,
			update: async () => null,
		})
		expect(tools.documents_create?.args).toBe(documents.tools.insert)
		expect(tools.documents_update?.args).toBe(documents.tools.update)
	})

	it('emits only the kinds with handlers, named <table>_<verb>', () => {
		const tools = createAgentTools(documents, {
			create: async () => null,
			get: async () => null,
		})
		expect(Object.keys(tools).sort()).toEqual([
			'documents_create',
			'documents_get',
		])
		expect(tools.documents_get?.description).toContain('documents')
	})

	it('routes invocations to the supplied handler with the input', async () => {
		const received: unknown[] = []
		const tools = createAgentTools(documents, {
			create: async (_ctx, input) => {
				received.push(input)
				return { id: 'doc_1' }
			},
		})
		const record = tools.documents_create
		if (!record) throw new Error('missing tool')
		const parsed = record.args.parse({ title: 'Plan' })
		expect(await record.handler({} as never, parsed as never)).toEqual({
			id: 'doc_1',
		})
		expect(received).toEqual([{ title: 'Plan' }])
	})

	it('ids present as plain strings in generated JSON schemas (jsonSafeZid)', () => {
		const tools = createAgentTools(documents, {
			update: async () => null,
			get: async () => null,
		})
		const getSchema = z.toJSONSchema(tools.documents_get?.args as z.ZodType)
		expect(
			(getSchema.properties as Record<string, { type?: string }>).id?.type,
		).toBe('string')
		const updateSchema = z.toJSONSchema(
			tools.documents_update?.args as z.ZodType,
		)
		expect(
			(updateSchema.properties as Record<string, { type?: string }>).id?.type,
		).toBe('string')
	})

	it('list args are the pagination opts boundary', () => {
		const tools = createAgentTools(documents, { list: async () => null })
		const parsed = tools.documents_list?.args.parse({
			paginationOpts: { numItems: 10, cursor: null },
		}) as { paginationOpts: { numItems: number } }
		expect(parsed.paginationOpts.numItems).toBe(10)
	})

	it('is shape-compatible with a createTool-style consumer', () => {
		// Structural stand-in for @convex-dev/agent's createTool signature.
		function createToolStub(definition: {
			description: string
			args: z.ZodType
			handler: (ctx: never, input: never) => Promise<unknown>
		}) {
			return definition
		}
		const tools = createAgentTools(documents, { create: async () => null })
		const record = tools.documents_create
		if (!record) throw new Error('missing tool')
		const tool = createToolStub(record)
		expect(tool.description).toBe('Create a documents record')
	})
})
