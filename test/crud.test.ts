// @vitest-environment edge-runtime
import { convexTest } from 'convex-test'
import { anyApi } from 'convex/server'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'

import { Foundation } from '../src/components/foundation/client'
import { createCrudCommands } from '../src/crud'
import { KitError } from '../src/errors'
import { tenantTable, zodTable } from '../src/zod-table'
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
		const row = (await t.query(api.getProject, { id })) as {
			name: string
			archivedAt?: number
		}
		expect(row.name).toBe('Renamed')
		expect(typeof row.archivedAt).toBe('number')
		expect(await t.query(api.auditCount, {})).toEqual([
			'projects.create',
			'projects.update',
			'projects.archive',
		])
	})

	it('rejects cross-tenant update and archive (RLS)', async () => {
		const t = harness()
		const id = await t
			.withIdentity(orgOneOwner)
			.mutation(api.crudCreate, { name: 'Mine' })
		const asTwo = t.withIdentity(orgTwoOwner)
		await expect(
			asTwo.mutation(api.crudUpdate, { id, name: 'stolen' }),
		).rejects.toThrow()
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
		const table = tenantTable('things', () => ({ name: z.string() }), {
			commandFields: ['name'],
		})
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
		const table = zodTable('notes', () => ({ text: z.string() }), {
			commandFields: ['text'],
		})
		const crud = createCrudCommands({
			Command: makeCommand(),
			table,
			aggregateType: 'note',
			actor: () => 'user',
		})
		expect(crud.commands.aggregates['notes.create']).toEqual(['note'])
		expect(
			(crud.operations as Record<string, { classification: string }>)[
				'notes.update'
			].classification,
		).toBe('business')
	})

	it('strict update input rejects fields outside commandFields', async () => {
		const table = zodTable(
			'notes',
			() => ({ text: z.string(), secret: z.string() }),
			{ commandFields: ['text'] },
		)
		const fakeDb = {
			insert: async () => 'id_1',
			patch: async () => undefined,
		}
		const crud = createCrudCommands<{ db: never }>({
			Command: makeCommand(),
			table,
			aggregateType: 'note',
			actor: () => 'user',
		})
		await expect(
			crud.executeUpdate({ db: fakeDb } as never, {
				id: 'id_1',
				data: { secret: 'leak' },
			} as never),
		).rejects.toThrow()
	})
})
