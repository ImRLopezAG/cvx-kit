/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-unknown-returns -- Negative fixtures deliberately build cyclic and unsupported values. */
// The scoped cursor codec on `k` schemas (U23): the `k` twin of the scoped-codec parts of
// querying-cursors.test.ts, which keep running through the v1 engine facade and bridge until U14.
// v1 rebuilt the Zod graph to contain async callbacks; a `k` parse is synchronous, so only a
// transform's promise result has to be contained.
import { expect, it } from 'vite-plus/test'
import { k, type KType } from '../src/k'
import {
	createCursorCodec,
	createScopedCursorCodec,
	CursorError,
	type ScopedCursorOptions,
} from '../src/querying/cursors'

const key = () => new Uint8Array(64).fill(31)
const config = () => ({ version: '1', currentKeyId: 'current', keys: { current: key() } })
const scope = {
	mode: 'authenticated',
	principal: 'user-id',
	organization: 'org',
	tenant: 'tenant-id',
	role: 'member',
	policyVersion: '1',
} as const

function codec<S extends KType>(
	schema: S,
	options: Partial<ScopedCursorOptions<S>> = {},
	transport = createCursorCodec(config()),
) {
	return createScopedCursorCodec(transport.custom, scope, {
		domain: 'native',
		bind: null,
		schema,
		...options,
	})
}

const invalid = (run: () => unknown) => {
	expect(run).toThrow(CursorError)
	expect(run).toThrow('Invalid cursor')
}

it('roundtrips a k payload deterministically and binds domain, bind and scope', () => {
	const schema = k.object({ native: k.string().nullable(), seen: k.int64() })
	const bound = codec(schema, { domain: 'native-v1', bind: { filters: { status: 'open' } } })
	const token = bound.seal({ native: 'private-native-position', seen: 9n })
	expect(bound.open(token)).toEqual({ native: 'private-native-position', seen: 9n })
	expect(token).not.toContain('private-native-position')
	expect(bound.seal({ native: 'private-native-position', seen: 9n })).toBe(token)
	invalid(() =>
		codec(schema, { domain: 'other', bind: { filters: { status: 'open' } } }).open(token),
	)
	invalid(() => codec(schema, { domain: 'native-v1', bind: { sort: 'desc' } }).open(token))
	const other = createScopedCursorCodec(
		createCursorCodec(config()).custom,
		{ ...scope, principal: 'other' },
		{ domain: 'native-v1', bind: { filters: { status: 'open' } }, schema },
	)
	invalid(() => other.open(token))
})

it('validates bounded Convex input and synchronous schema output on both seal and open', () => {
	const any = codec(k.any())
	const good = { native: null, seen: 42n, bytes: new Uint8Array([1, 2]).buffer, n: NaN }
	expect(any.open(any.seal(good))).toEqual(good)
	let reads = 0
	const getter = Object.defineProperty({}, 'secret', {
		enumerable: true,
		get() {
			reads++
			return 'sensitive'
		},
	})
	const cycle: Record<string, unknown> = {}
	cycle.self = cycle
	for (const value of [getter, cycle, new Date(), 1n << 64n, Array(513).fill(null)]) {
		invalid(() => any.seal(value))
		// SAFETY: invalid binding values deliberately exercise the JS runtime boundary.
		invalid(() => codec(k.any(), { bind: value as never }))
	}
	expect(reads).toBe(0)
	const token = any.seal({ seen: 'secret schema failure' })
	const strict = codec(k.object({ seen: k.int64() }))
	invalid(() => strict.open(token))
	// SAFETY: malformed JS callers deliberately bypass the schema's static input type.
	invalid(() => strict.seal({ seen: 'secret schema failure' } as never))
	for (const schema of [
		k.any().transform(() => {
			throw new Error('secret validation detail')
		}),
		k.any().transform(() => new Date()),
		k.any().transform(() => getter),
		k.any().transform(async () => 'async result'),
		k.object({ nested: k.any().transform(async () => 'async result') }),
	]) {
		const bad = codec(schema)
		for (const run of [() => bad.seal({ nested: 1 }), () => bad.open(token)]) {
			try {
				run()
				throw new Error('unexpected acceptance')
			} catch (error) {
				expect(error).toBeInstanceOf(CursorError)
				expect(error).toMatchObject({ message: 'Invalid cursor', code: 'invalid-cursor' })
				expect(JSON.stringify(error)).not.toMatch(/secret|validation detail/)
			}
		}
	}
	expect(reads).toBe(0)
})

it('roundtrips synchronous transforms and checks with distinct input and output types', () => {
	let checks = 0
	const transformed = codec(k.string().transform((value) => value.length))
	expect(transformed.open(transformed.seal('native'))).toBe(6)
	const checked = codec(
		k.object({ native: k.string() }).refine((value) => {
			checks++
			return value.native.length > 0
		}),
	)
	const token = checked.seal({ native: 'ok' })
	expect(checked.open(token)).toEqual({ native: 'ok' })
	expect(checks).toBe(2)
	invalid(() => checked.seal({ native: '' }))
})

it('rotates keys and rejects removed, malformed, oversized and tampered tokens', () => {
	const old = codec(k.string())
	const oldToken = old.seal('native')
	const rotatedConfig = {
		...config(),
		currentKeyId: 'new',
		keys: { current: key(), new: new Uint8Array(64).fill(12) },
	}
	const rotated = codec(k.string(), {}, createCursorCodec(rotatedConfig))
	expect(rotated.open(oldToken)).toBe('native')
	expect(rotated.open(rotated.seal('new-native'))).toBe('new-native')
	const removed = codec(
		k.string(),
		{},
		createCursorCodec({ ...rotatedConfig, keys: { new: rotatedConfig.keys.new } }),
	)
	invalid(() => removed.open(oldToken))
	for (const token of [
		'',
		'garbage',
		'cc.1.unknown.00',
		oldToken + '00',
		oldToken.slice(0, -2) + (oldToken.endsWith('00') ? '01' : '00'),
		oldToken.replace(/^cc\./, 'pc.'),
		'x'.repeat(100000),
	])
		invalid(() => rotated.open(token))
	invalid(() => old.seal('x'.repeat(9000)))
})
