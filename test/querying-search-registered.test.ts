import { it, expect } from 'vite-plus/test'
import { anyApi } from 'convex/server'
import { searchFixture } from './fixture-querying/search'
const identity = { subject: 'reader', org_id: 'one', role: 'reader' }
it('U11.2 registered auth and Effect return fixed search errors', async () => {
	const f = searchFixture()
	const t = f.t.withIdentity(identity)
	for (const endpoint of [anyApi.functions.page, anyApi.functions.effectPage])
		for (const [text, options, code] of [
			[' ', {}, 'SEARCH_TEXT_REQUIRED'],
			['x', { endCursor: 'private-cursor' }, 'SEARCH_END_CURSOR_UNSUPPORTED'],
			['x', { order: 'desc' }, 'SEARCH_ORDER_UNSUPPORTED'],
			['x', { maximumBytesRead: 1 }, 'SEARCH_OPTIONS_UNSUPPORTED'],
		] as const) {
			try {
				await t.query(endpoint, { text, options })
				throw Error('accepted')
			} catch (error) {
				expect(error).toHaveProperty(
					'data',
					expect.objectContaining({
						_tag: 'DeclaredFailure',
						version: 1,
						code,
						details: {},
					}),
				)
				expect(JSON.stringify(error)).not.toContain('private-cursor')
			}
		}
	expect(f.calls.roots).toBe(0)
})

async function seed(f: ReturnType<typeof searchFixture>, statuses: string[]) {
	return f.t.run(async ({ db }) => {
		const ids = []
		for (const status of statuses)
			ids.push(
				await db.insert('docs', {
					text: 'hello',
					tenant: 'one',
					secret: 'private',
					status,
				}),
			)
		return ids
	})
}
it('U11.3 counts denied roots and returns an empty continuing page without refill', async () => {
	const f = searchFixture()
	await seed(f, ['denied', 'denied', 'active', 'active'])
	const t = f.t.withIdentity(identity)
	const first = await t.query(anyApi.functions.page, { text: 'hello' })
	expect(first).toMatchObject({
		page: [],
		isDone: false,
		paginationMode: 'native-search',
		pageStatus: null,
		splitCursor: null,
	})
	expect(f.calls.roots).toBe(2)
	const second = await t.query(anyApi.functions.page, {
		text: 'hello',
		options: { cursor: first.continueCursor },
	})
	expect(second.page).toHaveLength(2)
	expect(f.calls.roots).toBe(4)
})
it('U11 review allows inactive selectors before and after search on both transports', async () => {
	const f = searchFixture()
	await seed(f, ['active'])
	const t = f.t.withIdentity(identity)
	for (const endpoint of [anyApi.functions.page, anyApi.functions.effectPage])
		for (const fluent of [
			'inactive-before-null',
			'inactive-before-undefined',
			'inactive-after-null',
			'inactive-after-undefined',
		]) {
			const page = await t.query(endpoint, { text: 'hello', fluent })
			expect(page.paginationMode).toBe('native-search')
			expect(page.page).toHaveLength(1)
		}
})
it('U11 review clamps oversized search targets on both transports', async () => {
	const f = searchFixture()
	await seed(f, Array(102).fill('active'))
	const t = f.t.withIdentity(identity)
	for (const endpoint of [anyApi.functions.page, anyApi.functions.effectPage]) {
		const page = await t.query(endpoint, { text: 'hello', options: { numItems: 101 } })
		expect(page.page).toHaveLength(100)
		expect(page.isDone).toBe(false)
		expect(page.paginationMode).toBe('native-search')
	}
	expect(f.calls.roots).toBe(200)
})
it('U11.3 pushes native equality filters before candidate accounting', async () => {
	const f = searchFixture()
	await seed(f, ['denied', 'denied', 'active', 'active'])
	const t = f.t.withIdentity(identity)
	const page = await t.query(anyApi.functions.page, {
		text: 'hello',
		options: { filters: { status: 'active' } },
	})
	expect(page.page).toHaveLength(2)
	expect(f.calls.roots).toBe(2)
})
it('U11.3 seals branch counts, page-size independent replay, cap admission and changed bindings', async () => {
	const f = searchFixture()
	await seed(f, Array(12).fill('active'))
	const t = f.t.withIdentity(identity)
	const options = { scanLimit: 9, numItems: 3 }
	const first = await t.query(anyApi.functions.page, {
		text: ' hello ',
		options,
	})
	const second = await t.query(anyApi.functions.page, {
		text: 'hello',
		options: { ...options, cursor: first.continueCursor, numItems: 2 },
	})
	const replay = await t.query(anyApi.functions.page, {
		text: 'hello',
		options: { ...options, cursor: first.continueCursor, numItems: 2 },
	})
	expect(second).toEqual(replay)
	const third = await t.query(anyApi.functions.page, {
		text: 'hello',
		options: { ...options, cursor: second.continueCursor, numItems: 4 },
	})
	expect(third).toMatchObject({ isDone: true, completeness: 'result-cap' })
	expect(third.page).toHaveLength(4)
	const calls = f.calls.roots
	expect(
		await t.query(anyApi.functions.page, {
			text: 'hello',
			options: { ...options, cursor: third.continueCursor },
		}),
	).toMatchObject({ page: [], isDone: true, completeness: 'result-cap' })
	expect(f.calls.roots).toBe(calls)
	for (const change of [
		{ text: 'different', options },
		{ text: 'hello', options: { ...options, scanLimit: 10 } },
		{ text: 'hello', options: { ...options, filters: { status: 'active' } } },
	]) {
		await expect(
			t.query(anyApi.functions.page, {
				...change,
				options: { ...change.options, cursor: first.continueCursor },
			}),
		).rejects.toHaveProperty('data', expect.objectContaining({ code: 'invalid-cursor' }))
	}
})
it('U11.3 checks protected search fields before even contradictory candidate reads', async () => {
	const f = searchFixture()
	await seed(f, ['active'])
	const t = f.t.withIdentity(identity)
	await expect(
		t.query(anyApi.functions.page, {
			index: 'search_secret',
			text: 'hello',
			options: { filters: { and: [{ status: 'a' }, { status: 'b' }] } },
		}),
	).rejects.toHaveProperty('data', expect.objectContaining({ code: 'FIELD_GROUP_DENIED' }))
	expect(f.calls.roots).toBe(0)
})
it('U11.3 many output keeps nested browse markers and directly resumable cursors', async () => {
	const f = searchFixture()
	const [parent] = await seed(f, ['active'])
	await f.t.run(async ({ db }) => {
		for (let i = 0; i < 5; i++) await db.insert('children', { parent, name: String(i) })
	})
	const page = await f.t.withIdentity(identity).query(anyApi.functions.nested, {
		text: 'hello',
		options: { numItems: 2 },
	})
	expect(page.page[0].children.page).toHaveLength(2)
	expect(page.page[0].children.isDone).toBe(false)
	expect(page.page[0].children).not.toHaveProperty('paginationMode')
	const next = await f.t.withIdentity(identity).query(anyApi.functions.resume, {
		parent,
		cursor: page.page[0].children.continueCursor,
		numItems: 2,
	})
	expect(next.page.map((r: { name: string }) => r.name)).toEqual(['2', '3'])
	const multiple = await f.t
		.withIdentity(identity)
		.query(anyApi.functions.multiple, { text: 'hello' })
	expect(multiple.page[0].children.page).toEqual(multiple.page[0].otherChildren.page)
})
it('U11.3 search descendants fail atomically where browse can partially split', async () => {
	const f = searchFixture({ rawCandidates: 1 })
	const [parent] = await seed(f, ['active'])
	await f.t.run(async ({ db }) => {
		for (let i = 0; i < 5; i++) await db.insert('children', { parent, name: String(i) })
	})
	await expect(
		f.t.withIdentity(identity).query(anyApi.functions.nested, {
			text: 'hello',
			options: { numItems: 3 },
		}),
	).rejects.toHaveProperty('data', expect.objectContaining({ _tag: 'UnknownFailure' }))
	expect(f.calls.children).toBe(1)
})
it('U11.3 private policy failures are sanitized and original boundary retries retain every row', async () => {
	const f = searchFixture()
	await seed(f, ['active', 'active'])
	const t = f.t.withIdentity(identity)
	for (const endpoint of [anyApi.functions.page, anyApi.functions.effectPage]) {
		f.control.throwPolicy = true
		try {
			await t.query(endpoint, { text: 'hello' })
			throw Error('accepted')
		} catch (error) {
			expect(error).toHaveProperty('data', {
				_tag: 'UnknownFailure',
				version: 1,
			})
			expect(JSON.stringify(error)).not.toContain('private-policy-value')
		}
		f.control.throwPolicy = false
		expect((await t.query(endpoint, { text: 'hello' })).page).toHaveLength(2)
	}
})

it('U11.3 deeper descendants share the atomic completion requirement', async () => {
	const f = searchFixture({ rawCandidates: 3 })
	const [parent] = await seed(f, ['active'])
	await f.t.run(async ({ db }) => {
		for (let i = 0; i < 6; i++) await db.insert('children', { parent, name: String(i) })
	})
	await expect(
		f.t.withIdentity(identity).query(anyApi.functions.deep, { text: 'hello' }),
	).rejects.toHaveProperty('data', { _tag: 'UnknownFailure', version: 1 })
})

it('U11.3 keeps policy dependencies in the shared request budget', async () => {
	const f = searchFixture({ readOperations: 2 })
	await seed(f, ['active', 'active'])
	f.control.readDependency = true
	const t = f.t.withIdentity(identity)
	await expect(t.query(anyApi.functions.page, { text: 'hello' })).rejects.toHaveProperty('data', {
		_tag: 'UnknownFailure',
		version: 1,
	})
	expect(f.calls.roots).toBe(2)
	f.control.readDependency = false
	expect((await t.query(anyApi.functions.page, { text: 'hello' })).page).toHaveLength(2)
})
it('U11.3 checks protected residual filter fields before contradictory search reads', async () => {
	const f = searchFixture()
	const t = f.t.withIdentity(identity)
	await expect(
		t.query(anyApi.functions.page, {
			text: 'hello',
			options: {
				filters: { and: [{ status: 'active' }, { status: 'denied' }, { secret: 'private' }] },
			},
		}),
	).rejects.toHaveProperty('data', expect.objectContaining({ code: 'FIELD_GROUP_DENIED' }))
	expect(f.calls.roots).toBe(0)
})
it('U11.3 rejects a failed DTO atomically on both registered transports', async () => {
	const f = searchFixture()
	const ids = await seed(f, ['active', 'active'])
	await f.t.run(({ db }) => db.patch(ids[1], { text: 'hello broken-dto' }))
	const t = f.t.withIdentity(identity)
	for (const endpoint of [anyApi.functions.page, anyApi.functions.effectPage])
		await expect(t.query(endpoint, { text: 'hello' })).rejects.toHaveProperty('data', {
			_tag: 'UnknownFailure',
			version: 1,
		})
	await f.t.run(({ db }) => db.patch(ids[1], { text: 'hello' }))
	expect((await t.query(anyApi.functions.page, { text: 'hello' })).page).toHaveLength(2)
})

it('U11.2 rejects raw JavaScript browse fluent methods and direct relation search', async () => {
	const f = searchFixture(),
		t = f.t.withIdentity(identity)
	for (const endpoint of [anyApi.functions.page, anyApi.functions.effectPage]) {
		for (const fluent of [
			'when-before',
			'when-after',
			'order-before',
			'order-after',
			'relation-search',
			'search-relation',
		])
			await expect(t.query(endpoint, { text: 'hello', fluent })).rejects.toHaveProperty(
				'data',
				expect.objectContaining({
					code: fluent.includes('relation')
						? 'SEARCH_RELATION_UNSUPPORTED'
						: 'SEARCH_ORDER_UNSUPPORTED',
				}),
			)
	}
	expect(f.calls.roots).toBe(0)
})

it('U11.3 native equality consumes fewer roots than an equivalent residual predicate', async () => {
	const f = searchFixture()
	await seed(f, ['denied', 'denied', 'active', 'active'])
	const t = f.t.withIdentity(identity)
	const native = await t.query(anyApi.functions.page, {
		text: 'hello',
		options: { numItems: 4, filters: { status: 'active' } },
	})
	expect(f.calls.roots).toBe(2)
	const residual = await t.query(anyApi.functions.page, {
		text: 'hello',
		options: { numItems: 4, filters: { status: { in: ['active'] } } },
	})
	expect(f.calls.roots).toBe(6)
	expect(residual.page.map((row: { _id: string }) => row._id).sort()).toEqual(
		native.page.map((row: { _id: string }) => row._id).sort(),
	)
})
it('U11.2 equivalent registries resume while scope and output changes invalidate search cursors', async () => {
	const f = searchFixture()
	await seed(f, Array(4).fill('active'))
	const t = f.t.withIdentity(identity)
	const first = await t.query(anyApi.functions.page, { text: 'hello' })
	const options = { cursor: first.continueCursor }
	const original = await t.query(anyApi.functions.page, { text: 'hello', options })
	expect(await t.query(anyApi.functions.equivalentPage, { text: 'hello', options })).toEqual(
		original,
	)
	await expect(
		f.t
			.withIdentity({ ...identity, subject: 'other' })
			.query(anyApi.functions.page, { text: 'hello', options }),
	).rejects.toHaveProperty('data', expect.objectContaining({ code: 'invalid-cursor' }))
	await expect(t.query(anyApi.functions.nested, { text: 'hello', options })).rejects.toHaveProperty(
		'data',
		expect.objectContaining({ code: 'invalid-cursor' }),
	)
})
