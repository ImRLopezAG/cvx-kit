// @vitest-environment edge-runtime
import { convexTest } from 'convex-test'
import { anyApi } from 'convex/server'
import { describe, expect, it } from 'vite-plus/test'

import { Foundation } from '../src/components/foundation/client'
import { createCrudCommands } from '../src/crud'
import { KitError } from '../src/errors'
import { k } from '../src/k'
import { kTable, tenantTable } from '../src/table'
import schema from './fixture-tenant/schema'

const modules = import.meta.glob('./fixture-tenant/**/*.ts')
const api = anyApi.functions

const orgOneOwner = { subject: 'user_1', org_id: 'org_1', role: 'owner' }
const orgTwoOwner = { subject: 'user_9', org_id: 'org_2', role: 'owner' }

function harness() {
	return convexTest(schema, modules)
}

describe('createCrudCommands on the real Convex runtime', () => {
	it('creates with enrich stamping, audits with the declared aggregate', async () => {
		const t = harness()
		const asOne = t.withIdentity(orgOneOwner)
		const id = await asOne.mutation(api.crudCreate, { name: 'Generated' })
		expect(id).toBeTruthy()
		expect(await asOne.query(api.listAll, {})).toEqual([{ name: 'Generated' }])
		expect(await t.query(api.auditCount, {})).toEqual(['projects.create'])
	})

	it('updates and archives with audits; archive is soft', async () => {
		const t = harness()
		const asOne = t.withIdentity(orgOneOwner)
		const id = await asOne.mutation(api.crudCreate, { name: 'Doc' })
		await asOne.mutation(api.crudUpdate, { id, name: 'Renamed' })
		await asOne.mutation(api.crudArchive, { id })
		const row = k
			.object({ name: k.string(), archivedAt: k.number().optional() })
			.strip()
			.parse(await t.query(api.getProject, { id }))
		expect(row.name).toBe('Renamed')
		expect(row.archivedAt).toEqual(expect.any(Number))
		expect(await t.query(api.auditCount, {})).toEqual([
			'projects.create',
			'projects.update',
			'projects.archive',
		])
	})

	it('rejects cross-tenant update and archive (RLS)', async () => {
		const t = harness()
		const id = await t.withIdentity(orgOneOwner).mutation(api.crudCreate, { name: 'Mine' })
		const asTwo = t.withIdentity(orgTwoOwner)
		await expect(asTwo.mutation(api.crudUpdate, { id, name: 'stolen' })).rejects.toThrow()
		await expect(asTwo.mutation(api.crudArchive, { id })).rejects.toThrow()
	})
})

describe('createCrudCommands construction', () => {
	function makeCommand() {
		const { Command } = new Foundation(
			{ functions: { status: 'status' } },
			{
				observability: {
					enabled: false,
					classifyError: () => ({
						outcome: 'failed',
						errorCode: 'UNEXPECTED',
					}),
				},
			},
		)
		return Command
	}

	it('fails fast when a tenantTable has no enrich callback', () => {
		const table = tenantTable(
			'things',
			{ name: k.string() },
			{
				commandFields: ['name'],
			},
		)
		expect(() =>
			createCrudCommands({
				Command: makeCommand(),
				table,
				aggregateType: 'thing',
				actor: () => 'user',
			}),
		).toThrow(KitError)
	})

	it('plain tables construct without enrich; defaults are business-classified', () => {
		const table = kTable(
			'notes',
			{ text: k.string() },
			{
				commandFields: ['text'],
			},
		)
		const crud = createCrudCommands({
			Command: makeCommand(),
			table,
			aggregateType: 'note',
			actor: () => 'user',
		})
		expect(crud.commands.aggregates['notes.create']).toEqual(['note'])
		expect(crud.operations['notes.update'].classification).toBe('business')
	})

	it('strict update input rejects fields outside commandFields', async () => {
		const table = kTable(
			'notes',
			{ text: k.string(), secret: k.string() },
			{
				commandFields: ['text'],
			},
		)
		const fakeDb = {
			insert: async () => {
				throw new Error('Invalid input must not insert')
			},
			patch: async () => undefined,
		}
		const crud = createCrudCommands<{ db: typeof fakeDb }, typeof table>({
			Command: makeCommand(),
			table,
			aggregateType: 'note',
			actor: () => 'user',
		})
		await expect(
			crud.executeUpdate(
				{ db: fakeDb },
				{
					id: table.tools.id.parse({ id: 'id_1' }).id,
					// Deliberately send a field excluded by commandFields.
					data: { secret: 'leak' },
				},
			),
		).rejects.toThrow(
			expect.objectContaining({ data: expect.objectContaining({ code: 'VALIDATION' }) }),
		)
	})

	it('an update with an out-of-range field fails with VALIDATION before any write', async () => {
		const table = kTable('notes', { text: k.string().max(5) }, { commandFields: ['text'] })
		const patched: unknown[] = []
		const fakeDb = {
			insert: async () => {
				throw new Error('Invalid input must not insert')
			},
			patch: async (...args: unknown[]) => {
				patched.push(args)
			},
		}
		const crud = createCrudCommands<{ db: typeof fakeDb }, typeof table>({
			Command: makeCommand(),
			table,
			aggregateType: 'note',
			actor: () => 'user',
		})
		const id = table.tools.id.parse({ id: 'id_1' }).id
		await expect(
			crud.executeUpdate({ db: fakeDb }, { id, data: { text: 'far too long' } }),
		).rejects.toMatchObject({
			data: {
				code: 'VALIDATION',
				issues: [expect.objectContaining({ code: 'too_big', path: ['data', 'text'] })],
			},
		})
		expect(patched).toEqual([])
		await crud.executeUpdate({ db: fakeDb }, { id, data: { text: 'ok' } })
		expect(patched).toEqual([[id, { text: 'ok' }]])
	})
})
