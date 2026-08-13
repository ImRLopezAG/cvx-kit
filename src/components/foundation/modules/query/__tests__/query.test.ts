import { describe, expect, it } from 'vite-plus/test'

import { Query } from '../query'

describe('Foundation Query', () => {
	it('runs injected policy before its handler', async () => {
		const order: string[] = []
		const query = new Query({
			defaults: { classification: 'authenticated' as const },
			execute: async (execution) => {
				order.push(`policy:${execution.metadata.classification}`)
				return execution.run()
			},
		})
		const execute = query.exec({
			handler: (_context: unknown, id: string) => {
				order.push('handler')
				return id
			},
		})

		await expect(execute({}, 'assignment-1')).resolves.toBe('assignment-1')
		expect(order).toEqual(['policy:authenticated', 'handler'])
	})
})
