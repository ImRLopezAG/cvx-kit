import { describe, expect, it } from 'vite-plus/test'
import { k } from '../src/k'
import { kTable } from '../src/table'

const base = k.object({ a: k.string(), b: k.string() })

describe('object derivation keys', () => {
	for (const method of ['pick', 'omit', 'partial', 'required'] as const) {
		it(`${method} refuses masks and malformed options before dropping checks`, () => {
			for (const schema of [
				base,
				base.refine(() => true),
				kTable('masks', base.shape).insertSchema,
			]) {
				for (const mask of [{ a: true }, { dropChecks: false }, { dropChecks: true, a: true }]) {
					// SAFETY: exercise invalid JavaScript callers without widening the public signatures.
					const invoke = schema[method] as (
						mask: Record<string, boolean | undefined>,
					) => typeof base
					expect(() => invoke.call(schema, mask)).toThrow(TypeError)
					expect(() => invoke.call(schema, mask)).toThrow(/key-list/)
				}
			}
		})
	}

	it('makes only selected fields optional and preserves no-key forms', () => {
		const patch = base.partial('a')
		expect(patch.parse({ b: 'x' })).toEqual({ b: 'x' })
		expect(patch.safeParse({ a: 'x' })).toMatchObject({ success: false, issues: [{ path: ['b'] }] })
		expect(base.partial().parse({})).toEqual({})
		expect(base.partial(undefined).parse({})).toEqual({})
		expect(
			base
				.refine(() => true)
				.partial({ dropChecks: true })
				.parse({}),
		).toEqual({})
		expect(
			base
				.refine(() => true)
				.partial('a', { dropChecks: true })
				.parse({ b: 'x' }),
		).toEqual({ b: 'x' })
		expect(base.partial().required('a').parse({ a: 'x' })).toEqual({ a: 'x' })
		expect(base.partial().required('a').safeParse({ b: 'x' }).success).toBe(false)
		expect(() => base.refine(() => true).pick('a')).toThrow('would drop')
	})
})
