import { expect, it } from 'vite-plus/test'
import { k } from '../src/k'

it('distinguishes invalid enum containers, empty values and non-string entries', () => {
	// @ts-expect-error untyped callers may pass a string
	expect(() => k.enum('abc')).toThrow(
		'k.enum() expects a string array or an object of string values',
	)
	expect(() => k.enum([])).toThrow('k.enum() needs at least one value')
	// @ts-expect-error numeric enum values are not supported
	expect(() => k.enum({ A: 1 })).toThrow('k.enum() value at key "A" must be a string')
	// @ts-expect-error numeric list values are not supported
	expect(() => k.enum(['a', 1])).toThrow('k.enum() value at index 1 must be a string')
})
