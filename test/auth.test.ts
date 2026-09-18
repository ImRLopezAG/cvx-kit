import type { GenericTableInfo, QueryInitializer } from 'convex/server'
import { describe, expect, it } from 'vite-plus/test'

import { createInclude, defaultRoleMap } from '../src/auth'
import { KitError } from '../src/errors'

describe('defaultRoleMap', () => {
	it('maps WorkOS member onto writer and passes known roles through', () => {
		expect(defaultRoleMap('member')).toBe('writer')
		expect(defaultRoleMap('  Admin ')).toBe('admin')
		expect(defaultRoleMap('reader')).toBe('reader')
	})

	it('rejects unknown roles instead of guessing', () => {
		expect(defaultRoleMap('owner')).toBeNull()
		expect(defaultRoleMap(undefined)).toBeNull()
	})
})

type Row = { _id: string }

function fakeQueryInitializer(rows: Row[]) {
	const calls: string[] = []
	function unsupported(): never {
		throw new Error('Unexpected query operation in include test')
	}
	const initializer: QueryInitializer<GenericTableInfo> = {
		take: async (limit) => rows.slice(0, limit),
		collect: unsupported,
		first: unsupported,
		unique: unsupported,
		paginate: unsupported,
		order: unsupported,
		filter: unsupported,
		withSearchIndex: unsupported,
		[Symbol.asyncIterator]: unsupported,
		withIndex: (indexName) => {
			calls.push(`withIndex:${indexName}`)
			return initializer
		},
		fullTableScan: () => {
			calls.push('fullTableScan')
			return initializer
		},
	}
	return { initializer, calls }
}

describe('createInclude', () => {
	const rows = Array.from({ length: 5 }, (_, index) => ({
		_id: `row_${index}`,
	}))

	it('selects the first matching index and bounds the read', async () => {
		const { initializer, calls } = fakeQueryInitializer(rows)
		const include = createInclude()
		const data = await include(initializer).matching('by_owner').matching('by_state').execute(3)
		expect(calls).toEqual(['withIndex:by_owner'])
		expect(data).toHaveLength(3)
	})

	it('falls back to a full scan only when nothing matched', async () => {
		const { initializer, calls } = fakeQueryInitializer(rows)
		const include = createInclude()
		await include(initializer)
			.when(null, (query) => query)
			.execute(2)
		expect(calls).toEqual(['fullTableScan'])
	})

	it('rejects unbounded or out-of-range limits', async () => {
		const { initializer } = fakeQueryInitializer(rows)
		const include = createInclude({ maxRows: 10 })
		await expect(include(initializer).execute(0)).rejects.toThrow(KitError)
		await expect(include(initializer).execute(11)).rejects.toThrow(/bounded query limit/)
		await expect(include(initializer).execute(2.5)).rejects.toThrow(KitError)
	})
})
