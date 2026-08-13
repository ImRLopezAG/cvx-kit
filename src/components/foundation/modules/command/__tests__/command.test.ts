import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'

import { Command } from '../command'

describe('Foundation Command', () => {
	it('validates a literal operation input and output inside host policy', async () => {
		const order: string[] = []
		const command = new Command({
			operations: {
				create: {
					command: z.object({ name: z.string() }).transform((value) => {
						order.push('parse-input')
						return value
					}),
					result: z.object({ id: z.string() }).transform((value) => {
						order.push('parse-output')
						return value
					}),
				},
			},
			execute: async (execution) => {
				order.push(`policy:${execution.operation}`)
				return execution.run()
			},
		})
		const execute = command.exec({
			operation: 'create',
			handler: (_context, input) => {
				order.push('handler')
				return { id: input.name }
			},
		})

		await expect(execute({}, { name: 'assignment-1' })).resolves.toEqual({
			id: 'assignment-1',
		})
		expect(order).toEqual([
			'parse-input',
			'policy:create',
			'handler',
			'parse-output',
		])
	})

	it('rejects invalid input before the handler', async () => {
		let ran = false
		const command = new Command({
			operations: {
				create: { command: z.object({ name: z.string() }), result: z.string() },
			},
			execute: (execution) => execution.run(),
		})
		const execute = command.exec({
			operation: 'create',
			handler: (_context, input) => {
				ran = true
				return input.name
			},
		})

		await expect(
			execute({}, { name: 42 } as unknown as { name: string }),
		).rejects.toThrow()
		expect(ran).toBe(false)
	})

	it('rejects invalid handler output', async () => {
		const command = new Command({
			operations: {
				create: {
					command: z.object({ name: z.string() }),
					result: z.object({ id: z.string() }),
				},
			},
			execute: (execution) => execution.run(),
		})
		const execute = command.exec({
			operation: 'create',
			handler: () => ({ id: 42 }) as unknown as { id: string },
		})

		await expect(execute({}, { name: 'assignment-1' })).rejects.toThrow()
	})

	it('rejects an unregistered dynamically selected operation', async () => {
		const command = new Command({
			operations: {
				create: {
					command: z.object({ operation: z.string() }),
					result: z.string(),
				},
			},
			execute: (execution) => execution.run(),
		})
		const execute = command.exec({
			dispatcher: z.object({ operation: z.string() }),
			select: (input) => input.operation as 'create',
			handler: (_context, input) => input.operation,
		})

		await expect(execute({}, { operation: 'missing' })).rejects.toThrow(
			'The selected command operation is not configured',
		)
	})
})
