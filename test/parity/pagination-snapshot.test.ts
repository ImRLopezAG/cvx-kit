// Characterises the native wire forms of the query engine's bottom layer (U23): the validators
// Convex receives for `paginationOpts(...)` and `paginated(dto)` args and page results, the shared
// filter contract schema, and the sealed cursor tokens. The snapshot was written from v1 (Zod) before
// the layer moved to `k`; v1 and v2 must both keep producing it, and v2 must open v1's tokens.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { NoOp } from 'convex-helpers/server/customFunctions'
import { queryGeneric } from 'convex/server'
import { v } from 'convex/values'
import { describe, expect, test } from 'vite-plus/test'
import { z } from 'zod'

import { k, type KType } from '../../src/k'
import { defineFilterContract } from '../../src/filters'
import {
	createCursorCodec,
	createScopedCursorCodec,
	CursorError,
	type CursorBinding,
} from '../../src/querying/cursors'
import { kCustomQuery, type KArgs } from '../../src/registration'
import { kTable, paginated } from '../../src/table'
import { createScopedCursorCodec as createV1ScopedCursorCodec } from '../../src/querying/v1-zod-cursors'
import { defineFilterContract as defineV1FilterContract } from '../../src/querying/v1-zod-contract'
import { zCustomQuery } from '../../src/zod-registration'
import { paginated as v1Paginated, zodTable, zodToConvex } from '../../src/zod-table'
import { toSnapshot, validatorJson, type Snapshot } from './helpers'

const SNAPSHOT_FILE = new URL('./v1-pagination.snapshot.json', import.meta.url)

type Registered = { isConvexFunction: true }

/** What Convex reads from a registered function, as the snapshot records it. */
type Exported = { args: Snapshot; returns: Snapshot }

function exported(fn: Registered): Exported {
	// SAFETY: native builders attach exportArgs/exportReturns at runtime; the public declaration strips them.
	const raw = fn as Registered & { exportArgs(): string; exportReturns(): string }
	return {
		args: digest(JSON.parse(raw.exportArgs())),
		returns: digest(JSON.parse(raw.exportReturns())),
	}
}

/**
 * Full filter validators run to megabytes (the reason the compact boundary exists), so the snapshot
 * keeps the size and SHA-256 of their key-sorted JSON; small values are kept as they are.
 */
export function digest(value: Snapshot): Snapshot {
	const text = JSON.stringify(toSnapshot(value))
	if (text.length <= 4096) return toSnapshot(value)
	return { bytes: text.length, sha256: createHash('sha256').update(text).digest('hex') }
}

const contractFields = {
	status: v.union(v.literal('open'), v.literal('done')),
	title: v.string(),
	score: v.number(),
	count: v.optional(v.int64()),
	active: v.boolean(),
	nullable: v.union(v.string(), v.null()),
	reference: v.id('targets'),
}

export const taskSelection = {
	status: true,
	title: true,
	score: true,
	count: true,
	active: true,
	note: true,
	owner: true,
	_id: true,
	_creationTime: true,
	createdAt: true,
} as const

export const memberSelection = { member: true, tag: true, archivedAt: true } as const

const key = () => new Uint8Array(64).fill(31)
export const cursorConfig = () => ({
	version: '1',
	currentKeyId: 'current',
	keys: { current: key() },
})
export const cursorBinding = (): CursorBinding => ({
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
export const cursorScope = {
	mode: 'authenticated',
	principal: 'user-id',
	organization: 'org',
	tenant: 'tenant-id',
	role: 'member',
	policyVersion: '1',
} as const
export const scopedOptions = { domain: 'native-v1', bind: { filters: { status: 'open' } } }
export const scopedPayload = { native: 'private-native-position', seen: 9n }

/** v1 observations, keyed like the snapshot. */
function v1Observations(): Snapshot {
	const tasks = zodTable('tasks', (id) => ({
		status: z.enum(['open', 'done']),
		title: z.string(),
		score: z.number(),
		count: z.bigint().optional(),
		active: z.boolean(),
		note: z.string().nullable(),
		owner: id('users'),
	}))
	const members = zodTable('members', (id) => ({
		member: z.union([id('users'), z.string()]),
		tag: z.union([z.literal('a'), z.literal(1)]),
	}))
	const register = (args: z.ZodObject | Record<string, z.ZodType>, returns?: z.ZodType) =>
		exported(zCustomQuery(queryGeneric, NoOp)({ args, returns, handler: () => null }))
	const taskOpts = tasks.paginationOpts(taskSelection)
	const memberOpts = members.paginationOpts(memberSelection)
	const compactOpts = tasks.paginationOpts(taskSelection, { validator: 'compact' })
	const page = v1Paginated(tasks.publicDto.extend({ title: z.string() }))
	const contract = defineV1FilterContract(contractFields)
	const transport = createCursorCodec(cursorConfig())
	const scoped = createV1ScopedCursorCodec(transport.custom, cursorScope, {
		...scopedOptions,
		schema: z.strictObject({ native: z.string().nullable(), seen: z.bigint() }),
	})
	return toSnapshot({
		paginationOpts: {
			tasks: {
				validator: digest(validatorJson(zodToConvex(taskOpts))),
				registered: register(taskOpts),
			},
			members: {
				validator: digest(validatorJson(zodToConvex(memberOpts))),
				registered: register(memberOpts),
			},
			tasksCompact: {
				validator: digest(validatorJson(zodToConvex(compactOpts))),
				registered: register(compactOpts),
			},
			nested: register({ paginationOpts: taskOpts }),
		},
		paginated: {
			args: register(page.args),
			result: register({}, page.result).returns,
		},
		contract: {
			schema: digest(validatorJson(zodToConvex(contract.schema))),
			native: contract.native,
			describe: contract.describe(),
			registered: register({ filters: contract.schema.optional() }),
		},
		cursors: {
			pc: transport.seal('opaque helper continuation', cursorBinding()),
			cc: transport.custom.seal('opaque custom', cursorBinding()),
			scoped: scoped.seal(scopedPayload),
		},
	})
}

/** The same observations from the v2 `k` layer: kTable, kCustomQuery and the `k` contract and codec. */
function v2Observations(): Snapshot {
	const tasks = kTable('tasks', {
		status: k.enum(['open', 'done']),
		title: k.string(),
		score: k.number(),
		count: k.int64().optional(),
		active: k.boolean(),
		note: k.string().nullable(),
		owner: k.id('users'),
	})
	const members = kTable('members', {
		member: k.union([k.id('users'), k.string()]),
		tag: k.union([k.literal('a'), k.literal(1)]),
	})
	const register = (args: KArgs, returns?: KType) =>
		exported(kQuery()({ args, returns, handler: () => null }))
	const taskOpts = tasks.paginationOpts(taskSelection)
	const memberOpts = members.paginationOpts(memberSelection)
	const compactOpts = tasks.paginationOpts(taskSelection, { validator: 'compact' })
	const page = paginated(tasks.publicDto.extend({ title: k.string() }))
	const contract = defineFilterContract(contractFields)
	const transport = createCursorCodec(cursorConfig())
	const scoped = createScopedCursorCodec(transport.custom, cursorScope, {
		...scopedOptions,
		schema: k.object({ native: k.string().nullable(), seen: k.int64() }),
	})
	return toSnapshot({
		paginationOpts: {
			tasks: {
				validator: digest(validatorJson(taskOpts.validator)),
				registered: register(taskOpts),
			},
			members: {
				validator: digest(validatorJson(memberOpts.validator)),
				registered: register(memberOpts),
			},
			tasksCompact: {
				validator: digest(validatorJson(compactOpts.validator)),
				registered: register(compactOpts),
			},
			nested: register({ paginationOpts: taskOpts }),
		},
		paginated: {
			args: register(page.args),
			result: register({}, page.result).returns,
		},
		contract: {
			schema: digest(validatorJson(contract.schema.validator)),
			native: contract.native,
			describe: contract.describe(),
			registered: register({ filters: contract.schema.optional() }),
		},
		cursors: {
			pc: transport.seal('opaque helper continuation', cursorBinding()),
			cc: transport.custom.seal('opaque custom', cursorBinding()),
			scoped: scoped.seal(scopedPayload),
		},
	})
}

function kQuery() {
	return kCustomQuery(queryGeneric, NoOp)
}

export function readPaginationSnapshot(): Snapshot {
	return JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'))
}

describe('v1 pagination, filter and cursor wire forms', () => {
	test('match the recorded snapshot', () => {
		const observed = v1Observations()
		if (!existsSync(SNAPSHOT_FILE))
			writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(observed, null, '\t')}\n`)
		expect(observed).toEqual(readPaginationSnapshot())
	})
})

describe('v2 pagination, filter and cursor wire forms', () => {
	test('match the v1 snapshot', () => {
		expect(v2Observations()).toEqual(readPaginationSnapshot())
	})

	test('open the sealed v1 tokens and reject tampered ones', () => {
		const recorded = readPaginationSnapshot()
		// SAFETY: the snapshot file is written by the v1 section above with these string tokens.
		const tokens = (recorded as { cursors: { pc: string; cc: string; scoped: string } }).cursors
		const transport = createCursorCodec(cursorConfig())
		expect(transport.open(tokens.pc, cursorBinding())).toBe('opaque helper continuation')
		expect(transport.custom.open(tokens.cc, cursorBinding())).toBe('opaque custom')
		const scoped = createScopedCursorCodec(transport.custom, cursorScope, {
			...scopedOptions,
			schema: k.object({ native: k.string().nullable(), seen: k.int64() }),
		})
		expect(scoped.open(tokens.scoped)).toEqual(scopedPayload)
		const flip = (token: string) => token.slice(0, -2) + (token.endsWith('00') ? '01' : '00')
		expect(() => transport.open(flip(tokens.pc), cursorBinding())).toThrow(CursorError)
		expect(() => transport.custom.open(flip(tokens.cc), cursorBinding())).toThrow(CursorError)
		expect(() => scoped.open(flip(tokens.scoped))).toThrow(CursorError)
		expect(() => transport.open(tokens.cc, cursorBinding())).toThrow(CursorError)
		expect(() =>
			transport.open(tokens.pc, { ...cursorBinding(), clientFilters: { status: 'done' } }),
		).toThrow(CursorError)
		const strict = createScopedCursorCodec(transport.custom, cursorScope, {
			...scopedOptions,
			schema: k.object({ native: k.string() }),
		})
		expect(() => strict.open(tokens.scoped)).toThrow(CursorError)
	})
})
