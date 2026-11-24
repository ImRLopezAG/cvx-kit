/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/no-object-parameters, anti-slop/no-unknown-parameters -- Fixtures toggle the action writer and drive erased Convex handlers and rejections. */
import { Effect, Exit } from 'effect'
import { convexTest } from 'convex-test'
import {
	actionGeneric,
	makeFunctionReference,
	type DataModelFromSchemaDefinition,
	type GenericActionCtx,
} from 'convex/server'
import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { combineErrorContracts } from '../src/modules/contracts/errors'
import { effectApiBuilder } from '../src/modules/effect/api'
import { createEffectFoundation } from '../src/modules/effect/foundation'
import { effectErrors } from '../src/modules/effect/failures'
import type { FailureAuditEntry } from '../src/modules/effect/failure-audit'
import type { AuditEntryInput } from '../src/components/foundation/client'
import schema from './fixture/schema'
import { settlementErrors } from './fixture/effectActions'

type Host = GenericActionCtx<DataModelFromSchemaDefinition<typeof schema>>
const modules = import.meta.glob('./fixture/**/*.ts')
const record = makeFunctionReference<'mutation', { title: string }, string>('effectActions:record')
const { attempt, fail } = effectErrors(settlementErrors)

function setup(options: { writer?: 'ok' | 'missing' | 'throws' } = {}) {
	const audits: AuditEntryInput[] = []
	const failures: FailureAuditEntry[] = []
	const events: string[] = []
	const writer = options.writer ?? 'ok'
	const foundation = createEffectFoundation({
		observability: { enabled: false, classifyError: () => ({ outcome: 'failed', errorCode: 'F' }) },
		writeAudit: () => undefined,
		...(writer === 'missing'
			? {}
			: {
					writeActionAudit: (_host: Host, entry: AuditEntryInput) => {
						if (writer === 'throws') throw Error('audit store down')
						audits.push(entry)
					},
				}),
		auditFailure: {
			errors: combineErrorContracts(settlementErrors),
			emit: (entry) => {
				failures.push(entry)
			},
		},
	})
	const actions = foundation.Action({
		context: (host: Host) => {
			events.push('context')
			return { host }
		},
		operations: ({ action }) => ({
			'settlement.post': action({
				input: z.object({ title: z.string() }).strict(),
				result: z.string(),
				guard: (_ctx, input) => {
					events.push('guard')
					if (input.title === 'denied') throw Error('denied')
				},
				handler: (input, ctx) => {
					events.push('handler')
					return attempt(() => ctx.host.runMutation(record, { title: input.title })).pipe(
						Effect.catchTag('DeclaredError', (error) =>
							error.code === 'SETTLED' ? fail('SETTLED') : Effect.die(error),
						),
					)
				},
				middleware: ({ next }) => {
					events.push('middleware')
					return next()
				},
				audit: ({ result }) => ({
					operation: 'settlement.post',
					actorId: 'system',
					aggregate: { type: 'settlement', id: result },
				}),
			}),
			'settlement.peek': action({
				input: z.string(),
				result: z.string(),
				classification: 'read',
				handler: (input) => input,
			}),
		}),
	})
	return { actions, audits, failures, events }
}

async function titles(t: ReturnType<typeof convexTest>) {
	return (await t.run((ctx) => ctx.db.query('documentHistory').collect())).map(
		(row) => row.documentTitle,
	)
}

describe('Effect Action registry', () => {
	it('runs a contract-typed action that writes through runMutation and audits', async () => {
		const h = setup()
		const t = convexTest(schema, modules)
		expect(
			await t.action((host) =>
				Effect.runPromise(h.actions.exec('settlement.post', { title: 'a' }, host)),
			),
		).toBe('a')
		expect(await titles(t)).toEqual(['a'])
		expect(h.events).toEqual(['context', 'middleware', 'guard', 'handler'])
		expect(h.audits).toEqual([
			{
				operation: 'settlement.post',
				actorId: 'system',
				aggregate: { type: 'settlement', id: 'a' },
				classification: 'action',
			},
		])
	})

	it('rejects invalid input before resolving context and stops at a failing guard', async () => {
		const h = setup()
		const t = convexTest(schema, modules)
		const invalid = await t.action((host) =>
			Effect.runPromiseExit(h.actions.exec('settlement.post', { title: 1 } as never, host)).then(
				Exit.isFailure,
			),
		)
		expect(invalid).toBe(true)
		expect(h.events).toEqual([])
		await expect(
			t.action((host) =>
				Effect.runPromise(h.actions.exec('settlement.post', { title: 'denied' }, host)),
			),
		).rejects.toThrow('denied')
		expect(h.events).toEqual(['context', 'middleware', 'guard'])
		expect(await titles(t)).toEqual([])
	})

	it('runs actions without audit and with a declared classification', async () => {
		const h = setup()
		expect(
			await Effect.runPromise(h.actions.withContext({} as Host).exec('settlement.peek', 'x')),
		).toBe('x')
		expect(h.audits).toEqual([])
	})

	it('fails before running an audited action when no action audit writer exists', async () => {
		const h = setup({ writer: 'missing' })
		const t = convexTest(schema, modules)
		await expect(
			t.action((host) =>
				Effect.runPromise(h.actions.exec('settlement.post', { title: 'a' }, host)),
			),
		).rejects.toMatchObject({ code: 'ACTION_AUDIT_WRITER_MISSING' })
		expect(h.events).toEqual([])
		expect(await titles(t)).toEqual([])
	})

	it('returns the result when the audit write fails after the side effect', async () => {
		const h = setup({ writer: 'throws' })
		const t = convexTest(schema, modules)
		expect(
			await t.action((host) =>
				Effect.runPromise(h.actions.exec('settlement.post', { title: 'b' }, host)),
			),
		).toBe('b')
		expect(await titles(t)).toEqual(['b'])
		expect(h.failures).toEqual([
			expect.objectContaining({
				kind: 'action',
				operation: 'settlement.post',
				errorCode: 'ACTION_AUDIT_WRITE_FAILED',
			}),
		])
	})

	it('recovers a declared ConvexError from runMutation and projects it at the action boundary', async () => {
		const h = setup()
		const t = convexTest(schema, modules)
		const registered = effectApiBuilder(actionGeneric, { errors: settlementErrors })({
			handler: (ctx) => h.actions.exec('settlement.post', { title: 'settled' }, ctx as Host),
		})
		const error = await t
			.action((ctx) =>
				// SAFETY: Convex builders retain their runtime _handler field.
				(
					registered as unknown as { _handler: (ctx: Host, args: object) => Promise<string> }
				)._handler(ctx, {}),
			)
			.catch((rejected: unknown) => rejected)
		expect(error).toBeInstanceOf(ConvexError)
		expect((error as ConvexError<string>).data).toMatchObject({
			_tag: 'DeclaredFailure',
			code: 'SETTLED',
		})
		expect(h.failures).toEqual([
			expect.objectContaining({ kind: 'action', errorCode: 'SETTLED', declared: true }),
		])
		expect(h.audits).toEqual([])
	})

	it('joins the request scope of an enclosing action', async () => {
		const h = setup()
		const foundation = createEffectFoundation({
			observability: {
				enabled: false,
				classifyError: () => ({ outcome: 'failed', errorCode: 'F' }),
			},
			writeAudit: () => undefined,
			writeActionAudit: (_host: Host, entry: AuditEntryInput) => {
				h.audits.push(entry)
			},
		})
		const outer = foundation.Action({
			context: (host: Host) => ({ inner: h.actions.withContext(host) }),
			operations: ({ action }) => ({
				'batch.run': action({
					input: z.string(),
					result: z.string(),
					handler: (title, ctx) => ctx.inner.exec('settlement.post', { title }),
					audit: () => ({
						operation: 'batch.run',
						actorId: 'system',
						aggregate: { type: 'batch', id: '1' },
					}),
				}),
			}),
		})
		const t = convexTest(schema, modules)
		await t.action((host) => Effect.runPromise(outer.exec('batch.run', 'c', host)))
		expect(h.audits.map((entry) => entry.operation)).toEqual(['batch.run'])
	})
	it('audits a nested action whose enclosing action declares no audit', async () => {
		const h = setup()
		const foundation = createEffectFoundation({
			observability: {
				enabled: false,
				classifyError: () => ({ outcome: 'failed', errorCode: 'F' }),
			},
			writeAudit: () => undefined,
		})
		const outer = foundation.Action({
			context: (host: Host) => ({ inner: h.actions.withContext(host) }),
			operations: ({ action }) => ({
				'batch.forward': action({
					input: z.string(),
					result: z.string(),
					handler: (title, ctx) => ctx.inner.exec('settlement.post', { title }),
				}),
			}),
		})
		const t = convexTest(schema, modules)
		await t.action((host) => Effect.runPromise(outer.exec('batch.forward', 'd', host)))
		expect(h.audits.map((entry) => entry.operation)).toEqual(['settlement.post'])
	})
})
