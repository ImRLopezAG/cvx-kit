/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening -- Negative fixtures deliberately build cyclic and unsupported values. */
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
