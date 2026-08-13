import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'

import { Foundation } from '../src/components/foundation/client'
import { ApplicationCommand, type AuditEntryInput } from '../src/command'

type Context = { actorId: string }

function foundationHarness() {
	const events: unknown[] = []
	// The host declares one Foundation; it is the sole source of the
	// Command kernel and observability, mirroring convex/foundation.ts.
	const foundation = new Foundation(
		{ functions: { status: 'status' } },
		{
			observability: {
				enabled: true,
				classifyError: () => ({ outcome: 'failed', errorCode: 'UNEXPECTED' }),
				emit: (event) => {
					events.push(event)
				},
			},
		},
	)
	return { foundation, events }
}

function harness() {
	const { foundation, events } = foundationHarness()
	const auditEntries: AuditEntryInput[] = []
	const operations = {
		'documents.rename': ApplicationCommand.operation({
			command: z.object({ id: z.string(), title: z.string() }).strict(),
			result: z.object({ ok: z.literal(true) }).strict(),
			classification: 'business',
			audit: () => ({
				operation: 'documents.rename',
				actorId: 'user_1',
				aggregate: { type: 'document', id: 'doc_1' },
			}),
		}),
	} as const
	const commands = new ApplicationCommand<Context, typeof operations>(
		operations,
		{
			foundation,
			writeAudit: (_context, entry) => {
				auditEntries.push(entry)
			},
		},
	)
	return { commands, events, auditEntries }
}

describe('ApplicationCommand', () => {
	it('validates input, executes, audits, and observes', async () => {
		const { commands, events, auditEntries } = harness()
		const rename = commands.exec({
			operation: 'documents.rename',
			handler: async () => ({ ok: true as const }),
		})
		const result = await rename(
			{ actorId: 'user_1' },
			{ id: 'doc_1', title: 'Renamed' },
		)
		expect(result).toEqual({ ok: true })
		expect(auditEntries).toEqual([
			{
				operation: 'documents.rename',
				actorId: 'user_1',
				aggregate: { type: 'document', id: 'doc_1' },
				classification: 'business',
			},
		])
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			operation: 'documents.rename',
			classification: 'business',
			outcome: 'completed',
		})
	})

	it('rejects invalid command input before the handler runs', async () => {
		const { commands, auditEntries } = harness()
		let executed = false
		const rename = commands.exec({
			operation: 'documents.rename',
			handler: async () => {
				executed = true
				return { ok: true as const }
			},
		})
		await expect(
			rename({ actorId: 'user_1' }, { id: 'doc_1' } as never),
		).rejects.toThrow()
		expect(executed).toBe(false)
		expect(auditEntries).toHaveLength(0)
	})

	it('skips the audit write when the operation returns null', async () => {
		const { foundation, events } = foundationHarness()
		const auditEntries: AuditEntryInput[] = []
		const operations = {
			'documents.read': ApplicationCommand.operation({
				command: z.object({}).strict(),
				result: z.object({ ok: z.literal(true) }).strict(),
				classification: 'read',
				audit: () => null,
			}),
		} as const
		const commands = new ApplicationCommand<Context, typeof operations>(
			operations,
			{
				foundation,
				writeAudit: (_context, entry) => {
					auditEntries.push(entry)
				},
			},
		)
		const read = commands.exec({
			operation: 'documents.read',
			handler: async () => ({ ok: true as const }),
		})
		await read({ actorId: 'user_1' }, {})
		expect(auditEntries).toHaveLength(0)
		expect(events).toHaveLength(1)
	})
})
