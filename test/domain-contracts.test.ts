import { expect, it } from 'vite-plus/test'
import { k } from '../src/k'
import { defineDomainContract } from '../src/contracts'
import { defineErrorContract } from '../src/errors'

it('preserves domain keys, schema objects, and error ownership', () => {
	const input = k.string().transform((text) => text.length)
	const result = k.number().transform((count) => ({ count }))
	const errors = defineErrorContract({ NOT_FOUND: { message: 'Missing', details: {} } })
	const contract = defineDomainContract({
		errors,
		commands: { create: { input, result, classification: 'business' } },
		queries: { get: { input: k.number(), result } },
	})
	expect(Object.keys(contract.commands)).toEqual(['create'])
	expect(contract.commands.create.input).toBe(input)
	expect(contract.commands.create.result).toBe(result)
	expect(contract.errors).toBe(errors)
})

it('accepts domains containing only one section or empty sections', () => {
	expect(defineDomainContract({ commands: {} }).commands).toEqual({})
	expect(defineDomainContract({ queries: {} }).queries).toEqual({})
})
