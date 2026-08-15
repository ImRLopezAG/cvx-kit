// @vitest-environment edge-runtime
import { convexTest } from 'convex-test'
import { anyApi } from 'convex/server'
import { describe, expect, it } from 'vite-plus/test'

import { KitError } from '../src/errors'
import { createWebhookBoundary } from '../src/webhooks'
import schema from './fixture-tenant/schema'

const modules = import.meta.glob('./fixture-tenant/**/*.ts')
const api = anyApi.functions

describe('recordWebhookEvent dedup on the real Convex runtime', () => {
	it('first delivery applies; identical redelivery is a duplicate no-op', async () => {
		const t = convexTest(schema, modules)
		const key = 'invoice.paid:evt_1:2026-08-14T00:00:00Z'
		const first = await t.mutation(api.receiveEvent, {
			eventKey: key,
			payload: '{}',
			source: 'vendor',
		})
		expect(first).toEqual({ duplicate: false, applied: true })
		const second = await t.mutation(api.receiveEvent, {
			eventKey: key,
			payload: '{}',
			source: 'vendor',
		})
		expect(second).toEqual({ duplicate: true, applied: false })
		expect(await t.query(api.countGlobals, {})).toBe(1)
	})

	it('distinct natural keys both apply', async () => {
		const t = convexTest(schema, modules)
		for (const id of ['evt_a', 'evt_b']) {
			await t.mutation(api.receiveEvent, {
				eventKey: `invoice.paid:${id}:1`,
				payload: '{}',
				source: 'vendor',
			})
		}
		expect(await t.query(api.countGlobals, {})).toBe(2)
	})
})

describe('createWebhookBoundary', () => {
	function fakeRequest(body: string, signature?: string) {
		return new Request('https://example.test/webhooks/vendor', {
			method: 'POST',
			body,
			headers: signature ? { 'x-signature': signature } : {},
		})
	}

	it('verifies over the RAW body before parsing, then delegates', async () => {
		const seenRaw: string[] = []
		const delegated: unknown[] = []
		const boundary = createWebhookBoundary({
			verify: (raw) => {
				seenRaw.push(raw)
				return true
			},
			eventKey: (raw) => {
				const parsed = JSON.parse(raw) as { event: string; id: string; updatedAt: string }
				return `${parsed.event}:${parsed.id}:${parsed.updatedAt}`
			},
			source: 'vendor',
		})
		const body = '{"event":"invoice.paid","id":"evt_1","updatedAt":"t1"}'
		const response = await boundary.handle(
			{
				runMutation: async (_target, args) => {
					delegated.push(args)
					return null
				},
			},
			fakeRequest(body),
			'internal.vendor.applyEvent',
		)
		expect(response.status).toBe(200)
		expect(seenRaw).toEqual([body])
		expect(delegated).toEqual([
			{
				eventKey: 'invoice.paid:evt_1:t1',
				payload: body,
				source: 'vendor',
			},
		])
	})

	it('failed verification throws before any delegation (fail closed)', async () => {
		const delegated: unknown[] = []
		const boundary = createWebhookBoundary({
			verify: () => false,
			eventKey: () => 'never',
		})
		await expect(
			boundary.handle(
				{
					runMutation: async (_t, args) => {
						delegated.push(args)
						return null
					},
				},
				fakeRequest('{}'),
				'x',
			),
		).rejects.toThrow(KitError)
		expect(delegated).toEqual([])
	})

	it('a throwing verify also fails closed', async () => {
		const boundary = createWebhookBoundary({
			verify: () => {
				throw new Error('hmac mismatch')
			},
			eventKey: () => 'never',
		})
		await expect(
			boundary.handle(
				{ runMutation: async () => null },
				fakeRequest('{}'),
				'x',
			),
		).rejects.toThrow(/WEBHOOK_SIGNATURE_INVALID|verification failed/)
	})
})
