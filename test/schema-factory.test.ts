import { expect, test } from 'vite-plus/test'
import { zid, zodToConvex } from 'convex-helpers/server/zod4'
import { z } from 'zod'
import { captureDto, materializeDto } from '../src/querying/schema-snapshot'

test('repeated recipe occurrences own definitions while refinements and native IDs stay live', () => {
	let allowed = true
	let calls = 0
	const shared = z.object({
		text: z.string().regex(/^valid$/g).refine(() => {
			calls++
			return allowed
		}),
		id: zid('items').refine(() => allowed),
	})
	const source = z.object({ left: shared, right: shared })
	const recipe = captureDto(source)
	const first = materializeDto(recipe)
	const second = materializeDto(recipe)
	const left = first.shape.left.shape.text._zod.def
	const right = first.shape.right.shape.text._zod.def
	expect(first.shape.left).not.toBe(first.shape.right)
	expect(first.shape.left).not.toBe(second.shape.left)
	expect(left).not.toBe(right)
	expect(left.checks).not.toBe(right.checks)
	const expression = left.checks![0]._zod.def
	const siblingExpression = right.checks![0]._zod.def
	if (!('pattern' in expression) || !('pattern' in siblingExpression))
		throw new Error('Expected regex checks')
	expect(expression.pattern).not.toBe(siblingExpression.pattern)
	expect(zodToConvex(first.shape.left.shape.id)).toMatchObject({ kind: 'id', tableName: 'items' })
	const value = { left: { text: 'valid', id: 'items:1' }, right: { text: 'valid', id: 'items:2' } }
	expect(first.safeParse(value).success).toBe(true)
	expect(first.safeParse(value).success).toBe(true)
	expect(calls).toBe(4)
	allowed = false
	expect(first.shape.left.shape.id.safeParse('items:1').success).toBe(false)
	expect(second.shape.right.shape.id.safeParse('items:2').success).toBe(false)
	expect(first.safeParse(value).success).toBe(false)
	expect(second.safeParse(value).success).toBe(false)
	allowed = true
	expect(first.shape.left.shape.id.safeParse('items:1').success).toBe(true)
	expect(first.shape.left.shape.id.safeParse(42).success).toBe(false)
	Reflect.set(first.shape.left.shape, 'text', z.number())
	expect(first.safeParse({ ...value, left: { ...value.left, text: 1 } }).success).toBe(true)
	expect(first.safeParse({ ...value, right: { ...value.right, text: 1 } }).success).toBe(false)
	expect(second.safeParse(value).success).toBe(true)
	Reflect.set(source.shape, 'left', z.number())
	expect(materializeDto(recipe).safeParse(value).success).toBe(true)
	expect(Object.isFrozen(source.shape)).toBe(false)
})
