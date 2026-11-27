import { describe, expect, expectTypeOf, it } from 'vite-plus/test'
import { toJsonSchema } from '../src/json-schema'
import { k } from '../src/k'
import { runDeclared } from '../src/k/parse'
import { kTable } from '../src/table'
import { toZod } from '../src/zod'

const issues = (result: {
	success: boolean
	issues?: readonly { code: string; message: string }[]
}) => (result.success ? [] : (result.issues ?? []).map(({ code, message }) => [code, message]))

describe('k.email', () => {
	it('accepts addresses Zod 4 accepts and reports invalid_format otherwise', () => {
		for (const good of ['a@b.co', 'first.last+tag@sub.example.com', "o'neil@example.org"])
			expect(k.email().parse(good)).toBe(good)
		for (const bad of ['', 'a', 'a@b', '.a@b.co', 'a..b@c.co', 'a@-b.co', 'a b@c.co', 'a@b.c'])
			expect(issues(k.email().safeParse(bad)), bad).toEqual([
				['invalid_format', 'Invalid email address'],
			])
		expect(issues(k.email('bad mail').safeParse('x'))).toEqual([['invalid_format', 'bad mail']])
		expect(issues(k.email({ error: 'bad' }).safeParse('x'))).toEqual([['invalid_format', 'bad']])
		expect(issues(k.email().safeParse(1)).map(([code]) => code)).toEqual(['invalid_type'])
	})

	it('is a string schema: chains, normalises first, native v.string()', () => {
		const email = k.string().trim().toLowerCase().email().max(254)
		expect(email.parse('  A@B.CO ')).toBe('a@b.co')
		expect(k.email().validator.kind).toBe('string')
		expect(k.email().optional().parse(undefined)).toBeUndefined()
		expectTypeOf<k.infer<ReturnType<typeof k.email>>>().toEqualTypeOf<string>()
	})
})

describe('k.url', () => {
	it('accepts what the URL parser accepts and narrows by protocol and hostname', () => {
		for (const good of ['https://example.com', 'http://localhost:3000/a?b=1#c', 'mailto:a@b.co'])
			expect(k.url().parse(good)).toBe(good)
		for (const bad of ['', 'example.com', '/relative', 'http://', 'not a url'])
			expect(issues(k.url().safeParse(bad)), bad).toEqual([['invalid_format', 'Invalid URL']])
		const https = k.url({ protocol: /^https$/, hostname: /\.example\.com$/, message: 'https only' })
		expect(https.parse('https://api.example.com/x')).toBe('https://api.example.com/x')
		expect(issues(https.safeParse('http://api.example.com'))).toEqual([
			['invalid_format', 'https only'],
		])
		expect(https.safeParse('https://example.org').success).toBe(false)
		expect(issues(k.url('bad url').safeParse('x'))).toEqual([['invalid_format', 'bad url']])
		// A global pattern keeps no state between parses.
		const sticky = k.url({ protocol: /https/g })
		expect([
			sticky.safeParse('https://a.co').success,
			sticky.safeParse('https://a.co').success,
		]).toEqual([true, true])
	})
})

describe('formats at boundaries', () => {
	it('run after Convex accepted the string, are allowed on table fields, and reach JSON Schema and Zod', () => {
		const args = k.object({ email: k.email(), site: k.url().optional() })
		expect(() => runDeclared(args, { email: 'nope' })).toThrow()
		expect(runDeclared(args, { email: 'a@b.co', site: 'https://a.co' })).toEqual({
			email: 'a@b.co',
			site: 'https://a.co',
		})
		const users = kTable('users', { email: k.email(), site: k.url({ protocol: /^https$/ }) })
		expect(users.insertSchema.safeParse({ email: 'a@b.co', site: 'http://a.co' }).success).toBe(
			false,
		)
		expect(toJsonSchema(args)).toMatchObject({
			properties: {
				email: { type: 'string', format: 'email' },
				site: { type: 'string', format: 'uri' },
			},
		})
		const zod = toZod(args)
		expect(zod.safeParse({ email: 'a@b.co', site: 'https://a.co' }).success).toBe(true)
		expect(zod.safeParse({ email: 'nope' }).success).toBe(false)
		expect(zod.safeParse({ email: 'a@b.co', site: 'nope' }).success).toBe(false)
	})
})

describe('k.custom', () => {
	type Brand = string & { readonly __brand: 'sku' }
	const isSku = (value: unknown): value is Brand => /^SKU-/.test(String(value))

	it('types the value and runs the guard', () => {
		const sku = k.custom<Brand>(isSku, 'not a sku')
		expectTypeOf<k.infer<typeof sku>>().toEqualTypeOf<Brand>()
		expectTypeOf<k.input<typeof sku>>().toEqualTypeOf<Brand>()
		expect(sku.parse('SKU-1')).toBe('SKU-1')
		expect(issues(sku.safeParse('x'))).toEqual([['custom', 'not a sku']])
		expect(issues(k.custom<Brand>(isSku).safeParse(1))).toEqual([['custom', 'Invalid input']])
	})

	it('without a guard accepts anything, typed as declared', () => {
		const payload = k.custom<{ id: string }>()
		expectTypeOf<k.infer<typeof payload>>().toEqualTypeOf<{ id: string }>()
		expect(payload.parse({ anything: 1 })).toEqual({ anything: 1 })
		expect(payload.validator.kind).toBe('any')
	})

	it('runs its guard at a function boundary, in objects, and composes with optional', () => {
		const args = k.object({ sku: k.custom<Brand>(isSku), note: k.custom<Brand>(isSku).optional() })
		expectTypeOf<k.infer<typeof args>>().toEqualTypeOf<{ sku: Brand; note?: Brand }>()
		expect(args.validator.fields.sku.kind).toBe('any')
		expect(() => runDeclared(args, { sku: 'nope' })).toThrow()
		expect(runDeclared(args, { sku: 'SKU-1' })).toEqual({ sku: 'SKU-1' })
		expect(toJsonSchema(k.custom<Brand>(isSku))).not.toHaveProperty('type')
	})
})
