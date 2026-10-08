import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { defineErrorContract } from '../src/modules/contracts/errors'
import {
	bindOperationExecutor,
	createOperationTools,
	selectOperation,
	type OperationToolJsonSchema,
} from '../src/modules/contracts/exposure'

const dialect = 'https://json-schema.org/draft/2020-12/schema' as const
const owner = Symbol('documents')
const input = z
	.object({ id: z.string().regex(/^doc_/), title: z.string().transform((s) => s.trim()) })
	.strict()
const result = z.object({ id: z.string(), title: z.string() })
const selected = selectOperation(owner, 'mutation', 'rename', { input, result })
const converter = {
	dialect,
	convert: () => ({
		$schema: dialect,
		type: 'object' as const,
		properties: {
			id: { type: 'string' as const, pattern: '^doc_' },
			title: { type: 'string' as const },
		},
		required: ['id', 'title'],
		additionalProperties: false,
	}),
}
const native = async (raw: z.input<typeof input>) => result.parse(input.parse(raw))
const executor = bindOperationExecutor(selected, { owner, key: 'rename', execute: native })

function definition() {
	return { operation: selected, executor, description: 'Rename a document', converter }
}

describe('selected operation tools', () => {
	it('exposes only explicit immutable contracts and named tools', async () => {
		const tools = createOperationTools({ rename_document: definition() })
		expect(Object.keys(tools)).toEqual(['rename_document'])
		expect(Object.keys(selected).sort()).toEqual(['input', 'key', 'kind', 'owner', 'result'])
		expect(Object.isFrozen(selected)).toBe(true)
		expect(Object.isFrozen(tools)).toBe(true)
		expect(Object.isFrozen(tools.rename_document)).toBe(true)
		expect(tools.rename_document.args).toMatchObject({ properties: { id: { pattern: '^doc_' } } })
		expect(await tools.rename_document.invoke({ id: 'doc_1', title: ' A ' })).toEqual({
			_tag: 'Success',
			value: { id: 'doc_1', title: 'A' },
		})
	})

	it('converts raw schema without executing transformations and decodes exactly once natively', async () => {
		let transforms = 0
		const schema = z
			.object({
				title: z.string().transform((s) => {
					transforms++
					return `${s}!`
				}),
			})
			.strict()
		const operation = selectOperation(owner, 'mutation', 'once', {
			input: schema,
			result: z.string(),
		})
		const bound = bindOperationExecutor(operation, {
			owner,
			key: 'once',
			execute: async (raw) => schema.parse(raw).title,
		})
		const tools = createOperationTools({
			once: {
				operation,
				executor: bound,
				description: 'Once',
				converter: {
					dialect,
					convert: (raw) => {
						expect(raw).toBe(schema)
						return {
							type: 'object',
							properties: { title: { type: 'string' } },
							required: ['title'],
							additionalProperties: false,
						}
					},
				},
			},
		})
		expect(transforms).toBe(0)
		expect(await tools.once.invoke({ title: 'A' })).toEqual({ _tag: 'Success', value: 'A!' })
		expect(transforms).toBe(1)
	})

	it('rejects duplicate names, forged selections, missing executors, owner/key and descriptor mismatch', () => {
		expect(() =>
			createOperationTools([
				{ name: 'same', ...definition() },
				{ name: 'same', ...definition() },
			]),
		).toThrow()
		const other = selectOperation(owner, 'mutation', 'other', { input, result })
		// @ts-expect-error deliberately incompatible selected operation at untrusted runtime boundary
		expect(() => createOperationTools({ bad: { ...definition(), operation: other } })).toThrow()
		expect(() =>
			// @ts-expect-error missing authorized executor
			createOperationTools({ bad: { operation: selected, description: 'Bad', converter } }),
		).toThrow()
		expect(() =>
			// @ts-expect-error different owner cannot authorize this selected operation
			bindOperationExecutor(selected, { owner: Symbol('other'), key: 'rename', execute: native }),
		).toThrow()
		expect(() =>
			// @ts-expect-error different key cannot authorize selected operation
			bindOperationExecutor(selected, { owner, key: 'other', execute: native }),
		).toThrow()
		expect(() =>
			bindOperationExecutor({ ...selected }, { owner, key: 'rename', execute: native }),
		).toThrow()
		expect(() =>
			createOperationTools({ bad: { ...definition(), executor: { ...executor } } }),
		).toThrow()
	})

	it('rejects unsupported dialect, shapes and conversion failures without invoking native calls', () => {
		for (const convert of [
			() => ({ type: 'string' }),
			() => ({ type: 'object', surprise: true }),
			() => ({ type: 'object', $schema: 'wrong' }),
			() => ({ type: 'object', properties: { bad: { type: 'date' } } }),
			() => {
				throw Error('unsupported transform')
			},
		]) {
			expect(() =>
				createOperationTools({ bad: { ...definition(), converter: { dialect, convert } } }),
			).toThrow()
		}
		expect(() =>
			createOperationTools({
				// @ts-expect-error unsupported dialect
				bad: { ...definition(), converter: { ...converter, dialect: 'draft-07' } },
			}),
		).toThrow()
	})

	it('rejects malformed keyword values and freezes the published JSON schema snapshot', () => {
		const invalidSchemas: OperationToolJsonSchema[] = [
			{ type: 'object', properties: { title: { type: 'string', minLength: 'one' } } },
			{ type: 'object', properties: { title: { type: 'string', pattern: false } } },
			{ type: 'object', properties: { title: { enum: 'A' } } },
		]
		for (const invalid of invalidSchemas) {
			expect(() =>
				createOperationTools({
					bad: { ...definition(), converter: { dialect, convert: () => invalid } },
				}),
			).toThrow()
		}
		const schema = { type: 'object', properties: { title: { type: 'string' } } }
		const tools = createOperationTools({
			rename: { ...definition(), converter: { dialect, convert: () => schema } },
		})
		schema.properties.title.type = 'number'
		expect(tools.rename.args).toMatchObject({ properties: { title: { type: 'string' } } })
		expect(Object.isFrozen(tools.rename.args)).toBe(true)
		expect(Object.isFrozen(tools.rename.args.properties)).toBe(true)
	})

	it('rejects authority fields through the native raw input contract and retains host authority', async () => {
		let writes = 0
		const authorized = bindOperationExecutor(selected, {
			owner,
			key: 'rename',
			execute: async (raw) => {
				const decoded = input.parse(raw)
				writes++
				return result.parse(decoded)
			},
		})
		const tools = createOperationTools({ rename: { ...definition(), executor: authorized } })
		expect(
			// @ts-expect-error authority fields are not raw operation arguments
			await tools.rename.invoke({ id: 'doc_1', title: 'A', tenant: 'forged', actor: 'admin' }),
		).toEqual({ _tag: 'UnknownFailure', version: 1 })
		expect(writes).toBe(0)
	})

	it('returns the same bounded public query DTO produced by the native boundary', async () => {
		const publicSchema = z.object({ id: z.string(), title: z.string() })
		const query = selectOperation(owner, 'query', 'get', {
			input: z.object({ id: z.string() }),
			result: z.object({ id: z.string(), title: z.string(), secret: z.string() }),
			wire: { schema: publicSchema },
		})
		const execute = async (raw: { id: string }) =>
			publicSchema.parse({ id: raw.id, title: 'Visible', secret: 'private' })
		const bound = bindOperationExecutor(query, { owner, key: 'get', execute })
		const tools = createOperationTools({
			get: { operation: query, executor: bound, description: 'Get', converter },
		})
		expect(await tools.get.invoke({ id: 'doc_1' })).toEqual({
			_tag: 'Success',
			value: await execute({ id: 'doc_1' }),
		})
		expect(JSON.stringify(await tools.get.invoke({ id: 'doc_1' }))).not.toContain('private')
	})

	it('projects only checked native transport failures after the native Promise rejects', async () => {
		const errors = defineErrorContract({
			Missing: { message: 'Document missing', details: { id: z.string() } },
		})
		let rejected = false
		const declared = errors.project(errors.create('Missing', { id: 'doc_1' }))
		const failures = [
			new ConvexError(declared),
			Error('private diagnostic'),
			{ data: declared },
			new ConvexError({ ...declared, stack: 'secret' }),
		]
		for (const failure of failures) {
			const bound = bindOperationExecutor(selected, {
				owner,
				key: 'rename',
				execute: async () => {
					await Promise.resolve()
					rejected = true
					throw failure
				},
			})
			const tools = createOperationTools({ rename: { ...definition(), executor: bound, errors } })
			const outcome = await tools.rename.invoke({ id: 'doc_1', title: 'A' })
			expect(rejected).toBe(true)
			expect(outcome).toEqual(
				failure === failures[0] ? declared : { _tag: 'UnknownFailure', version: 1 },
			)
			expect(JSON.stringify(outcome)).not.toContain('secret')
		}
	})
})
