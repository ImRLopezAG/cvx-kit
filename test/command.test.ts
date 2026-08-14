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

describe('Foundation Command guards and permissions', () => {
	function guardedHarness(options?: {
		checkPermission?: (
			context: never,
			input: { permission: string; operation: string },
		) => void
	}) {
		const auditEntries: AuditEntryInput[] = []
		const calls: string[] = []
		const { Command } = new Foundation(
			{ functions: { status: 'status' } },
			{
				observability: {
					enabled: false,
					classifyError: () => ({
						outcome: 'denied',
						errorCode: 'FORBIDDEN',
					}),
					writeAudit: (_context, entry) => {
						auditEntries.push(entry)
					},
				},
				checkPermission: options?.checkPermission as never,
			},
		)
		const operations = {
			'documents.publish': Command.operation({
				command: z.object({ state: z.string() }).strict(),
				result: z.object({ ok: z.literal(true) }).strict(),
				classification: 'business',
				permission: 'documents.manage',
				guard: (async (_ctx: Context, command: { state: string }) => {
					calls.push('operation-guard')
					if (command.state !== 'draft') throw new Error('NOT_DRAFT')
				}) as never,
				audit: () => ({
					operation: 'documents.publish',
					actorId: 'user_1',
					aggregate: { type: 'document', id: 'doc_1' },
				}),
			}),
		} as const
		const commands = new Command<Context, typeof operations>(operations, {
			guard: (async () => {
				calls.push('default-guard')
			}) as never,
		})
		const publish = commands.exec({
			operation: 'documents.publish',
			handler: async () => {
				calls.push('handler')
				return { ok: true as const }
			},
		})
		return { publish, calls, auditEntries }
	}

	it('runs permission → default guard → operation guard → handler', async () => {
		const { publish, calls } = guardedHarness({
			checkPermission: (_context, input) => {
				calls.push(`permission:${input.permission}@${input.operation}`)
			},
		})
		await publish({ actorId: 'user_1' }, { state: 'draft' })
		expect(calls).toEqual([
			'permission:documents.manage@documents.publish',
			'default-guard',
			'operation-guard',
			'handler',
		])
	})

	it('a denying guard stops the handler and skips the audit', async () => {
		const { publish, calls, auditEntries } = guardedHarness({
			checkPermission: () => {},
		})
		await expect(
			publish({ actorId: 'user_1' }, { state: 'published' }),
		).rejects.toThrow('NOT_DRAFT')
		expect(calls).not.toContain('handler')
		expect(auditEntries).toEqual([])
	})

	it('a denying permission check stops everything', async () => {
		const { publish, calls } = guardedHarness({
			checkPermission: () => {
				throw new Error('FORBIDDEN')
			},
		})
		await expect(
			publish({ actorId: 'user_1' }, { state: 'draft' }),
		).rejects.toThrow('FORBIDDEN')
		expect(calls).toEqual([])
	})

	it('fails closed when a permission is declared but no checker exists', async () => {
		const { publish } = guardedHarness()
		await expect(
			publish({ actorId: 'user_1' }, { state: 'draft' }),
		).rejects.toThrow(/checkPermission/)
	})
})

describe('Foundation Command aggregate allowlist', () => {
	function aggregateHarness(auditType: string) {
		const auditEntries: AuditEntryInput[] = []
		const { Command } = new Foundation(
			{ functions: { status: 'status' } },
			{
				observability: {
					enabled: false,
					classifyError: () => ({
						outcome: 'failed',
						errorCode: 'UNEXPECTED',
					}),
					writeAudit: (_context, entry) => {
						auditEntries.push(entry)
					},
				},
			},
		)
		const operations = {
			'documents.archive': Command.operation({
				command: z.object({ id: z.string() }).strict(),
				result: z.object({ ok: z.literal(true) }).strict(),
				classification: 'business',
				aggregates: ['document'],
				audit: () => ({
					operation: 'documents.archive',
					actorId: 'user_1',
					aggregate: { type: auditType, id: 'doc_1' },
				}),
			}),
		} as const
		const commands = new Command<Context, typeof operations>(operations)
		const archive = commands.exec({
			operation: 'documents.archive',
			handler: async () => ({ ok: true as const }),
		})
		return { commands, archive, auditEntries }
	}

	it('writes audits whose aggregate type is declared', async () => {
		const { commands, archive, auditEntries } = aggregateHarness('document')
		await archive({ actorId: 'user_1' }, { id: 'doc_1' })
		expect(auditEntries).toHaveLength(1)
		expect(commands.aggregates['documents.archive']).toEqual(['document'])
	})

	it('throws when the audit names an undeclared aggregate type', async () => {
		const { archive, auditEntries } = aggregateHarness('invoice')
		await expect(
			archive({ actorId: 'user_1' }, { id: 'doc_1' }),
		).rejects.toThrow(/outside its declared aggregates/)
		expect(auditEntries).toEqual([])
	})
})
