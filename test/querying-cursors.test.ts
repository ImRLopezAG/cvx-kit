/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening -- Negative fixtures deliberately build cyclic and unsupported values. */
import { z } from 'zod'
import type { Value } from 'convex/values'
import { createQueryEngine } from '../src/querying'
import { harness, managed, scope, seed } from './fixture-querying/scalar'
import { expect, it } from 'vite-plus/test'
import {
	createCursorCodec,
	CursorError,
	CursorConfigurationError,
	type CursorBinding,
} from '../src/querying/cursors'

const key = () => new Uint8Array(64).fill(31)
const config = () => ({ version: '1', currentKeyId: 'current', keys: { current: key() } })
const binding = (): CursorBinding => ({
	table: 'tasks',
	index: 'by_status',
	order: 'asc',
	clientFilters: { status: 'open' },
	serverFilters: { archived: false },
	relationPath: ['projects', 'tasks'],
	parent: 'parent-id',
	principal: 'user-id',
	tenant: 'tenant-id',
	policyVersion: '1',
	engineVersion: '1',
	registryVersion: '1',
})
const invalid = (run: () => void) => {
	expect(run).toThrow(CursorError)
	expect(run).toThrow('Invalid cursor')
}

it('roundtrips opaque helper strings and empty terminal cursors deterministically and confidentially', () => {
	const codec = createCursorCodec(config())
	for (const raw of ['', 'private traversal 🐱', '\ud800', '{"not":"a helper format contract"}']) {
		const token = codec.seal(raw, binding())
		expect(codec.open(token, binding())).toBe(raw)
		expect(codec.seal(raw, binding())).toBe(token)
		const transport = new TextDecoder().decode(
			Uint8Array.from(token.split('.')[3]!.match(/../g)!, (x) => parseInt(x, 16)),
		)
		if (raw.length > 2) expect(transport).not.toContain(raw)
	}
})
it('permits native split and continuation boundaries in start/end slots while binding nested scope', () => {
	const codec = createCursorCodec(config()),
		scope = binding()
	const splitCursor = codec.seal('opaque helper split', scope)
	const continueCursor = codec.seal('opaque helper continuation', scope)
	// Installed Convex splitQuery uses the split boundary in both slots and continuation as end.
	const halves = [
		{ cursor: null, endCursor: splitCursor },
		{ cursor: splitCursor, endCursor: continueCursor },
	]
	expect(codec.open(halves[0]!.endCursor, scope)).toBe('opaque helper split')
	expect(codec.open(halves[1]!.cursor!, scope)).toBe('opaque helper split')
	expect(codec.open(halves[1]!.endCursor, scope)).toBe('opaque helper continuation')
	const nestedScope = {
		...scope,
		relationPath: [...scope.relationPath, 'comments'],
		parent: 'task-id',
	}
	const nestedCursor = codec.seal('opaque nested helper boundary', nestedScope)
	for (const slot of [{ cursor: nestedCursor }, { endCursor: nestedCursor }]) {
		const token = 'cursor' in slot ? slot.cursor! : slot.endCursor!
		expect(codec.open(token, nestedScope)).toBe('opaque nested helper boundary')
		invalid(() => codec.open(token, scope))
	}
})
it('binds every query and immutable security field, excluding page size', () => {
	const codec = createCursorCodec(config()),
		original = binding(),
		token = codec.seal('opaque', original)
	for (const change of [
		{ table: 'other' },
		{ index: 'other' },
		{ order: 'desc' as const },
		{ clientFilters: { status: 'closed' } },
		{ serverFilters: { archived: true } },
		{ principal: 'other' },
		{ tenant: 'other' },
		{ policyVersion: '2' },
		{ relationPath: ['other'] },
		{ parent: 'other' },
		{ engineVersion: '2' },
		{ registryVersion: '2' },
	])
		invalid(() => codec.open(token, { ...original, ...change }))
	expect(codec.open(token, { ...original, pageSize: 99 })).toBe('opaque')
	expect(codec.seal('opaque', { ...original, pageSize: 1 })).toBe(token)
	expect(
		codec.open(
			codec.seal('', {
				...original,
				index: undefined,
				parent: undefined,
				tenant: undefined,
			}),
			{ ...original, index: null, parent: null, tenant: null },
		),
	).toBe('')
})
it('rejects tamper, tag changes, truncation, noncanonical transport, unknown version/key and oversized input uniformly', () => {
	const codec = createCursorCodec(config()),
		token = codec.seal('opaque', binding()),
		parts = token.split('.')
	const changed = [...parts]
	changed[3] = (parts[3]![0] === '0' ? '1' : '0') + parts[3]!.slice(1)
	for (const bad of [
		'',
		'raw cursor',
		token + '.',
		token.slice(0, -1),
		token + '00',
		changed.join('.'),
		token.toUpperCase(),
		token.replace('pc.1.', 'pc.2.'),
		token.replace('.current.', '.missing.'),
		'pc.1.current.' + '00'.repeat(50000),
		'pc.1.current.zz',
		'pc.1.current.' + '00'.repeat(15),
	])
		invalid(() => codec.open(bad, binding()))
	invalid(() => codec.seal('x'.repeat(8193), binding()))
})
it('retains old keys for rotation and snapshots configuration and key buffers', () => {
	const cfg = config(),
		old = createCursorCodec(cfg),
		token = old.seal('opaque', binding())
	const rotated = createCursorCodec({
		version: '1',
		currentKeyId: 'next',
		keys: { current: key(), next: new Uint8Array(64).fill(32) },
	})
	expect(rotated.open(token, binding())).toBe('opaque')
	const next = rotated.seal('opaque', binding())
	expect(next).toContain('.next.')
	invalid(() => old.open(next, binding()))
	invalid(() =>
		createCursorCodec({
			version: '1',
			currentKeyId: 'next',
			keys: { next: new Uint8Array(64).fill(32) },
		}).open(token, binding()),
	)
	cfg.keys.current.fill(0)
	cfg.version = '2'
	cfg.currentKeyId = 'removed'
	cfg.keys.current = new Uint8Array(1)
	expect(old.seal('opaque', binding())).toBe(token)
	expect(old.open(token, binding())).toBe('opaque')
	for (const size of [0, 32, 48, 63, 65])
		expect(() =>
			createCursorCodec({ ...config(), keys: { current: new Uint8Array(size) } }),
		).toThrow(CursorConfigurationError)
	for (const cfg of [
		{ ...config(), version: '' },
		{ ...config(), currentKeyId: 'absent' },
		{ ...config(), currentKeyId: 'bad.id' },
	])
		expect(() => createCursorCodec(cfg)).toThrow(CursorConfigurationError)
})
it('preserves native Convex identities and own dictionaries independent of insertion order', () => {
	const codec = createCursorCodec(config()),
		values = [
			0,
			-0,
			0n,
			1n,
			NaN,
			Infinity,
			-Infinity,
			new Uint8Array([1, 2]).buffer,
			new Uint8Array([2, 1]).buffer,
		]
	const tokens = values.map((value) =>
		codec.seal('opaque', { ...binding(), clientFilters: { value } }),
	)
	expect(new Set(tokens).size).toBe(values.length)
	const own = Object.create(null)
	own.__proto__ = 'own'
	own.z = 1n
	const reversed = Object.create(null)
	reversed.z = 1n
	reversed.__proto__ = 'own'
	expect(codec.seal('opaque', { ...binding(), clientFilters: own })).toBe(
		codec.seal('opaque', { ...binding(), clientFilters: reversed }),
	)
	expect(codec.seal('opaque', { ...binding(), clientFilters: { b: 2, a: 1 } })).toBe(
		codec.seal('opaque', { ...binding(), clientFilters: { a: 1, b: 2 } }),
	)
})
it('rejects numeric array properties outside its elements in both seal and open', () => {
	const codec = createCursorCodec(config())
	const token = codec.seal('opaque', { ...binding(), clientFilters: [] })
	for (const name of ['4294967295', '4294967296', '9007199254740993']) {
		const value = Object.defineProperty([], name, { value: 'ignored', enumerable: true })
		const malformed = { ...binding(), clientFilters: value }
		invalid(() => codec.seal('opaque', malformed))
		invalid(() => codec.open(token, malformed))
	}
	const ordinary = { ...binding(), clientFilters: [null, 'value'] }
	expect(codec.open(codec.seal('opaque', ordinary), ordinary)).toBe('opaque')
})
it('rejects unsupported values, accessors, cycles and bounded traversal without invoking getters', () => {
	const codec = createCursorCodec(config()),
		cycle: Record<string, unknown> = {}
	cycle.self = cycle
	let reads = 0
	const accessor = Object.defineProperty({}, 'x', {
		enumerable: true,
		get() {
			reads++
			return 1
		},
	})
	const array = Object.defineProperty([1], '0', {
		get() {
			reads++
			return 1
		},
	})
	const hidden = Object.defineProperty({}, 'hidden', {
		get() {
			reads++
			return 1
		},
	})
	class UnsupportedArray extends Array {}
	let deep: unknown = null
	for (let i = 0; i < 40; i++) deep = [deep]
	// SAFETY: deliberate invalid binding values test the runtime rejection boundary.
	for (const value of [
		new Date(),
		new UnsupportedArray(),
		undefined,
		Array(512).fill([1, 2, 3, 4]),
		Object.fromEntries(Array.from({ length: 129 }, (_, i) => [String(i), null])),
		new Uint8Array(1),
		new Map(),
		cycle,
		accessor,
		array,
		hidden,
		deep,
		Array(513).fill(null),
		{ text: 'x'.repeat(17000) },
		1n << 64n,
	])
		// SAFETY: malformed internal bindings deliberately exercise runtime rejection.
		invalid(() => codec.seal('opaque', { ...binding(), clientFilters: value as never }))
	expect(reads).toBe(0)
})

// U6 facade proofs reuse scalar fixture registration only for exhaustive scope cases;
// querying-security-auth.test.ts separately proves actual auth-constructor registration.
it('binds the public facade to every managed scope field, domain, bind and central policy', async () => {
	const f = harness()
	await f.t.run(async ({ db }) => {
		let adapterCalls = 0
		const engine = createQueryEngine(f, {
			cursor: config(),
			trustedAdapter: () => {
				adapterCalls++
				throw new Error('adapter must not override registered scope')
			},
		})
		const ctx = managed(db)
		const opts = {
			domain: 'native-v1',
			bind: { filters: { status: 'open' }, sort: 'asc' },
			schema: z.strictObject({ native: z.string().nullable(), seen: z.bigint() }),
		}
		const codec = engine.cursorCodec(ctx, opts)
		const token = codec.seal({ native: 'private-native-position', seen: 9n })
		expect(codec.open(token)).toEqual({ native: 'private-native-position', seen: 9n })
		expect(token).not.toContain('private-native-position')
		expect(codec.seal({ native: 'private-native-position', seen: 9n })).toBe(token)
		for (const change of [
			{ mode: 'system' as const },
			{ principal: 'other' },
			{ organization: 'other' },
			{ tenant: 'other' },
			{ role: 'other' },
		])
			invalid(() =>
				engine.cursorCodec(managed(db, {}, 'allow', { ...scope, ...change }), opts).open(token),
			)
		invalid(() => engine.cursorCodec(ctx, { ...opts, domain: 'other' }).open(token))
		invalid(() => engine.cursorCodec(ctx, { ...opts, bind: { sort: 'desc' } }).open(token))
		invalid(() =>
			createQueryEngine(f, { cursor: config(), policyVersion: 'changed' })
				.cursorCodec(ctx, opts)
				.open(token),
		)
		// Capture binding at construction; caller mutation must not silently change it.
		opts.bind.filters.status = 'changed'
		expect(codec.open(token).seen).toBe(9n)
		expect(adapterCalls).toBe(0)
	})
})

it('rotates the shared keys and rejects removed, malformed, oversized and tampered public tokens', async () => {
	const f = harness()
	await f.t.run(async ({ db }) => {
		const ctx = managed(db)
		const opts = { domain: 'native', bind: null, schema: z.string() }
		const old = createQueryEngine(f, { cursor: config() }).cursorCodec(ctx, opts)
		const oldToken = old.seal('native')
		const rotatedConfig = {
			...config(),
			currentKeyId: 'new',
			keys: { current: key(), new: new Uint8Array(64).fill(12) },
		}
		const rotated = createQueryEngine(f, { cursor: rotatedConfig }).cursorCodec(ctx, opts)
		expect(rotated.open(oldToken)).toBe('native')
		expect(rotated.open(rotated.seal('new-native'))).toBe('new-native')
		const removed = createQueryEngine(f, {
			cursor: { ...rotatedConfig, keys: { new: rotatedConfig.keys.new } },
		}).cursorCodec(ctx, opts)
		invalid(() => removed.open(oldToken))
		for (const token of [
			'',
			'garbage',
			'cc.1.unknown.00',
			oldToken + '00',
			oldToken.slice(0, -2) + (oldToken.endsWith('00') ? '01' : '00'),
			'x'.repeat(100000),
		])
			invalid(() => rotated.open(token))
		invalid(() => old.seal('x'.repeat(9000)))
	})
})

it('validates bounded Convex input and synchronous schema output on both seal and open with fixed errors', async () => {
	const f = harness()
	await f.t.run(async ({ db }) => {
		const engine = createQueryEngine(f, { cursor: config() })
		const ctx = managed(db)
		const opts = { domain: 'native', bind: null, schema: z.any() }
		const codec = engine.cursorCodec(ctx, opts)
		const good = {
			native: null,
			seen: 42n,
			bytes: new Uint8Array([1, 2]).buffer,
			n: NaN,
			negativeZero: -0,
		}
		const result = codec.open(codec.seal(good))
		expect(result).toEqual(good)
		const proto = JSON.parse('{"__proto__":{"safe":true}}')
		expect(codec.open(codec.seal(proto))).toEqual(proto)
		let reads = 0
		const getter = Object.defineProperty({}, 'secret', {
			enumerable: true,
			get() {
				reads++
				return 'sensitive'
			},
		})
		const buffer = Object.defineProperty(new ArrayBuffer(1), 'byteLength', {
			get() {
				reads++
				return 1
			},
		})
		const cycle: Record<string, unknown> = {}
		cycle.self = cycle
		let deep: unknown = null
		for (let i = 0; i < 30; i++) deep = [deep]
		for (const value of [
			getter,
			buffer,
			cycle,
			deep,
			new Date(),
			1n << 64n,
			Array(513).fill(null),
			{ secret: 'x'.repeat(17000) },
		]) {
			invalid(() => codec.seal(value))
			// Bind uses the same accessor/cycle/value boundary.
			// SAFETY: invalid binding values deliberately exercise the JS runtime boundary.
			invalid(() => engine.cursorCodec(ctx, { ...opts, bind: value as never }))
		}
		expect(reads).toBe(0)
		const token = codec.seal({ seen: 'secret schema failure' })
		const strict = engine.cursorCodec(ctx, {
			...opts,
			schema: z.strictObject({ seen: z.bigint() }),
		})
		invalid(() => strict.open(token))
		// SAFETY: malformed JS callers deliberately bypass the schema's static input type.
		invalid(() => strict.seal({ seen: 'secret schema failure' } as never))
		for (const schema of [
			z.any().transform(() => {
				throw new Error('secret validation detail')
			}),
			z.any().transform(() => new Date()),
			z.any().transform(() => getter),
			z.any().transform(async () => 'async result'),
		]) {
			// SAFETY: runtime rejection must also protect untyped JS consumers and invalid transform outputs.
			const bad = engine.cursorCodec(ctx, { ...opts, schema: schema as z.ZodType<Value> })
			for (const run of [() => bad.seal(null), () => bad.open(token)]) {
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
})

it('separates public and engine tokens in both directions even with rewritten prefixes', async () => {
	const f = harness()
	await seed(f, 3)
	await f.t.run(async ({ db }) => {
		const ctx = managed(db)
		const codec = f.querying.cursorCodec(ctx, { domain: 'native', bind: null, schema: z.string() })
		const page = await f.querying(ctx).tasks.paginate({ cursor: null, numItems: 1 })
		const token = codec.seal('native')
		for (const engineToken of [page.continueCursor, page.continueCursor.replace(/^pc\./, 'cc.')])
			invalid(() => codec.open(engineToken))
		for (const publicToken of [token, token.replace(/^cc\./, 'pc.')])
			await expect(
				f.querying(ctx).tasks.paginate({ cursor: publicToken, numItems: 1 }),
			).rejects.toThrow('Invalid cursor')
	})
})

it('roundtrips synchronous schema transforms with distinct input and output types', async () => {
	const f = harness()
	await f.t.run(async ({ db }) => {
		const codec = f.querying.cursorCodec(managed(db), {
			domain: 'transformed',
			bind: null,
			schema: z.string().transform((value) => value.length),
		})
		expect(codec.open(codec.seal('native'))).toBe(6)
	})
})

it('accepts only the configured trusted query adapter and captures its scope without reading rows', async () => {
	const f = harness()
	await f.t.run(async ({ db }) => {
		const reader = {
			get: db.get.bind(db),
			query: db.query.bind(db),
			normalizeId: db.normalizeId.bind(db),
			system: db.system,
		}
		let calls = 0
		const engine = createQueryEngine(f, {
			cursor: config(),
			trustedAdapter: (ctx) => {
				calls++
				return ctx.db === reader
					? { reader, scope: { ...scope, mode: 'trusted' }, rules: {}, defaultPolicy: 'deny' }
					: null
			},
		})
		const options = { domain: 'native', bind: null, schema: z.string() }
		const codec = engine.cursorCodec({ db: reader }, options)
		const token = codec.seal('native')
		expect(codec.open(token)).toBe('native')
		invalid(() => engine.cursorCodec(managed(reader), options).open(token))
		expect(calls).toBe(1)
		expect(Object.keys(codec).sort()).toEqual(['open', 'seal'])
	})
})

it('preserves nested synchronous validation and leaves consumer schema callbacks unchanged', async () => {
	const f = harness()
	let transforms = 0
	let refinements = 0
	let checks = 0
	const nested = z.string().transform((value) => {
		transforms++
		return value.length
	})
	const schema = z
		.object({ native: z.lazy(() => nested) })
		.refine((value) => {
			refinements++
			return value.native > 0
		})
		.superRefine((value, ctx) => {
			checks++
			if (value.native > 10) ctx.addIssue({ code: 'custom', message: 'private-sync-check' })
		})
	const definition = schema._zod.def
	const transform = nested._zod.def.out._zod.def.transform
	await f.t.run(async ({ db }) => {
		const codec = f.querying.cursorCodec(managed(db), { domain: 'nested-sync', bind: null, schema })
		const token = codec.seal({ native: 'native' })
		expect(token).toBeTypeOf('string')
		expect(codec.open(token)).toEqual({ native: 6 })
		expect({ transforms, refinements, checks }).toEqual({
			transforms: 2,
			refinements: 2,
			checks: 2,
		})
		invalid(() => codec.seal({ native: '' }))
		invalid(() => codec.seal({ native: 'longer than ten' }))
	})
	expect(schema._zod.def).toBe(definition)
	expect(nested._zod.def.out._zod.def.transform).toBe(transform)
	expect(schema.parse({ native: 'ok' })).toEqual({ native: 2 })
})

it('keeps synchronous default callbacks lazy and applies them independently on seal and open', async () => {
	const f = harness()
	let calls = 0
	const schema = z.object({
		native: z.string().default(() => {
			calls++
			return 'default'
		}),
	})
	await f.t.run(async ({ db }) => {
		const codec = f.querying.cursorCodec(managed(db), {
			domain: 'default-sync',
			bind: null,
			schema,
		})
		expect(calls).toBe(0)
		const token = codec.seal({})
		expect(calls).toBe(1)
		expect(codec.open(token)).toEqual({ native: 'default' })
		expect(calls).toBe(2)
	})
})
