import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'

import {
	Foundation,
	type AuditEntryInput,
} from '../src/components/foundation/client'

type Context = { actorId: string }

// The host declares one Foundation and destructures everything from it —
// the single kernel source, mirroring convex/foundation.ts.
function foundationHarness() {
	const events: unknown[] = []
	const auditEntries: AuditEntryInput[] = []
	const { Command } = new Foundation(
		{ functions: { status: 'status' } },
		{
			observability: {
				enabled: true,
				classifyError: () => ({ outcome: 'failed', errorCode: 'UNEXPECTED' }),
				emit: (event) => {
					events.push(event)
				},
				writeAudit: (_context, entry) => {
					auditEntries.push(entry)
				},
			},
		},
	)
	return { Command, events, auditEntries }
}

function harness() {
	const { Command, events, auditEntries } = foundationHarness()
	const operations = {
		'documents.rename': Command.operation({
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
	const commands = new Command<Context, typeof operations>(operations)
	return { commands, events, auditEntries }
}

describe('Foundation Command protocol', () => {
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
		const { Command, events, auditEntries } = foundationHarness()
		const operations = {
			'documents.read': Command.operation({
				command: z.object({}).strict(),
				result: z.object({ ok: z.literal(true) }).strict(),
				classification: 'read',
				audit: () => null,
			}),
		} as const
		const commands = new Command<Context, typeof operations>(operations)
		const read = commands.exec({
			operation: 'documents.read',
			handler: async () => ({ ok: true as const }),
		})
		await read({ actorId: 'user_1' }, {})
		expect(auditEntries).toHaveLength(0)
		expect(events).toHaveLength(1)
	})
})
