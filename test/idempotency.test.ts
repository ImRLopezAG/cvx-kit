/* oxlint-disable anti-slop/no-unknown-parameters -- Test helpers exercise the explicit untrusted raw-input boundary. */
import { expect, it } from 'vite-plus/test'
import { Context, Effect } from 'effect'
import { CommitTsPlaceholder } from 'convex/values'
import { bindEffectCommand } from '../src/modules/effect/command'
import { Observability } from '../src/components/foundation/modules/observability/observability'
import { z } from 'zod'
import { zodContract } from '../src/contracts'
import { decodeContract } from '../src/modules/contracts/contract'
import {
	canonicalConvexBytes,
	captureIdempotencyInvocation,
	transactionalIdempotency,
	type IdempotencyReceipt,
} from '../src/modules/contracts/idempotency'
import { effectTransactionalIdempotency } from '../src/modules/effect/idempotency'
import { effectContract } from '../src/modules/effect/schema'

const bounds = {
	maxDepth: 20,
	maxNodes: 1000,
	maxBytes: 10000,
	maxArrayLength: 100,
	maxObjectFields: 100,
}
const versions = { operation: '1', contract: '1', binding: '1', fingerprintPolicy: 'raw-v1' }
function invocation(rawInput: unknown, scope = 'tenant:principal', overrides = {}) {
	return captureIdempotencyInvocation({
		binding: { kind: 'mutation', atomicity: 'same-mutation' },
		identity: { operation: 'save', scope, key: 'retry' },
		versions: { ...versions, ...overrides },
		rawInput,
		canonical: { bounds },
	})
}
function ledger() {
	const rows = new Map<string, IdempotencyReceipt[]>()
	const events: string[] = []
	let revoked = false
	let decoded = 0
	const replayResult = zodContract(
		z.string().transform((wire) => {
			decoded++
			return Number(wire)
		}),
	)
	const adapter = transactionalIdempotency({
		final: { replayResult, encode: (result: number) => String(result) },
		fingerprint: (bytes: string) => {
			events.push('fingerprint')
			return bytes
		},
		authorize: () => {
			events.push('authorize')
			if (revoked) throw Error('revoked')
		},
		lookup: (identity) => {
			events.push('lookup')
			return rows.get(JSON.stringify(identity)) ?? []
		},
		claim: (identity, receipt) => {
			events.push('claim')
			const key = JSON.stringify(identity)
			rows.set(key, [receipt])
			return key
		},
		complete: (key: string, receipt) => {
			events.push('complete')
			rows.set(key, [receipt])
		},
	})
	return {
		adapter,
		rows,
		events,
		revoke: () => {
			revoked = true
		},
		decoded: () => decoded,
	}
}
it('canonicalizes bounded Convex values with stable keys and distinct numeric/binary identity', () => {
	expect(canonicalConvexBytes({ z: { b: 2, a: 1 }, a: undefined }, bounds)).toBe(
		canonicalConvexBytes({ z: { a: 1, b: 2 } }, bounds),
	)
	const values = [
		0,
		-0,
		0n,
		1n,
		new Uint8Array([1]).buffer,
		new Uint8Array([2]).buffer,
		NaN,
		Infinity,
		-Infinity,
		-(1n << 63n),
		(1n << 63n) - 1n,
	]
	expect(new Set(values.map((value) => canonicalConvexBytes(value, bounds))).size).toBe(
		values.length,
	)
	const shared = { a: 1 }
	expect(canonicalConvexBytes([shared, shared], bounds)).toBe(
		canonicalConvexBytes([{ a: 1 }, { a: 1 }], bounds),
	)
})
it('rejects unsupported, cyclic, malformed keys and policy bounds', () => {
	interface CyclicInput {
		self?: CyclicInput
	}
	const cyclic: CyclicInput = {}
	cyclic.self = cyclic
	class Custom {}
	for (const value of [
		undefined,
		[undefined],
		new Date(),
		new Map(),
		new Set(),
		new Uint8Array([1]),
		new DataView(new ArrayBuffer(1)),
		new Custom(),
		new CommitTsPlaceholder(),
		() => 1,
		Symbol(),
		cyclic,
		1n << 63n,
		{ $bad: undefined },
		{ '\n': 1 },
	]) {
		expect(() => canonicalConvexBytes(value, bounds)).toThrow()
	}
	for (const limit of [
		'maxDepth',
		'maxNodes',
		'maxBytes',
		'maxArrayLength',
		'maxObjectFields',
	] as const) {
		expect(() =>
			canonicalConvexBytes({ nested: [1, 2], other: 3 }, { ...bounds, [limit]: 1 }),
		).toThrow()
	}
})
it('authorizes before lookup and stores final wire; replay decodes once without completion', async () => {
	const h = ledger()
	const fresh = await h.adapter.prepare(invocation({ title: ' abc ' }))
	expect(fresh.kind).toBe('execute')
	if (fresh.kind === 'execute') await fresh.complete(7)
	expect([...h.rows.values()][0]?.[0]?.result).toBe('7')
	h.events.length = 0
	const replay = await h.adapter.prepare(invocation({ title: ' abc ' }))
	expect(replay).toEqual({ kind: 'replay', result: '7' })
	expect(h.decoded()).toBe(0)
	if (replay.kind === 'replay')
		expect(await decodeContract(h.adapter.replayResult, replay.result)).toEqual({ value: 7 })
	expect(h.decoded()).toBe(1)
	expect(h.events).toEqual(['authorize', 'lookup', 'fingerprint'])
	h.revoke()
	h.events.length = 0
	await expect(h.adapter.prepare(invocation({ title: ' abc ' }))).rejects.toThrow('revoked')
	expect(h.events).toEqual(['authorize'])
})
it('retains raw input, separates scopes and rejects conflicts/stale metadata before fingerprint', async () => {
	const h = ledger()
	const raw = { title: ' abc ' }
	const captured = invocation(raw)
	raw.title = 'abc'
	const fresh = await h.adapter.prepare(captured)
	if (fresh.kind === 'execute') await fresh.complete(1)
	await expect(h.adapter.prepare(invocation({ title: 'abc' }))).rejects.toMatchObject({
		code: 'conflict',
	})
	for (const field of ['operation', 'contract', 'binding', 'fingerprintPolicy'] as const) {
		h.events.length = 0
		await expect(
			h.adapter.prepare(invocation({ title: 'different' }, undefined, { [field]: '2' })),
		).rejects.toMatchObject({ code: 'stale' })
		expect(h.events).toEqual(['authorize', 'lookup'])
	}
	expect((await h.adapter.prepare(invocation(raw, 'other:principal'))).kind).toBe('execute')
	expect(h.rows.size).toBe(2)
})
it('rejects duplicate, corrupt and pending retained receipts without replacement', async () => {
	for (const state of ['duplicate', 'corrupt', 'pending', 'missing-result'] as const) {
		const h = ledger()
		const captured = invocation('x')
		const fresh = await h.adapter.prepare(captured)
		if (fresh.kind === 'execute') await fresh.complete(1)
		const key = [...h.rows.keys()][0]!
		const receipt = h.rows.get(key)![0]!
		if (state === 'duplicate') h.rows.set(key, [receipt, receipt])
		if (state === 'corrupt')
			// SAFETY: this deliberate malformed retained row tests runtime rejection despite the fixture's typed map.
			// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Deliberate corrupt retained storage fixture.
			h.rows.set(key, [{ ...receipt, fingerprint: 3 } as unknown as IdempotencyReceipt])
		if (state === 'pending') h.rows.set(key, [{ ...receipt, state: 'pending' }])
		if (state === 'missing-result') {
			const { result: _result, ...withoutResult } = receipt
			h.rows.set(key, [withoutResult])
		}
		const baseline = h.rows.get(key)
		h.events.length = 0
		await expect(h.adapter.prepare(captured)).rejects.toMatchObject({
			code: state === 'duplicate' ? 'ambiguous' : state === 'missing-result' ? 'corrupt' : state,
		})
		expect(h.rows.get(key)).toBe(baseline)
		expect(h.events).toEqual(['authorize', 'lookup'])
	}
})
it('rejects unsupported binding declarations before any ledger callback', () => {
	for (const binding of [
		{ kind: 'action', atomicity: 'same-mutation' },
		{ kind: 'mutation', atomicity: 'external-store' },
	]) {
		expect(() =>
			captureIdempotencyInvocation({
				// SAFETY: intentionally bypass the static native-mutation contract to prove runtime rejection.
				binding: binding as never,
				identity: { operation: 'save', scope: 'trusted', key: 'key' },
				versions,
				rawInput: 'x',
				canonical: { bounds },
			}),
		).toThrow()
	}
})
it('keeps Effect callbacks lazy and ordinary failures as defects', async () => {
	const events: string[] = []
	const adapter = effectTransactionalIdempotency({
		final: { replayResult: zodContract(z.number()), encode: (n: number) => n },
		authorize: () => {
			events.push('authorize')
			return Effect.succeed(undefined)
		},
		lookup: () => {
			events.push('lookup')
			return Promise.resolve([])
		},
		fingerprint: (bytes: string) => bytes,
		claim: () => {
			events.push('claim')
			throw Error('ordinary')
		},
		complete: () => Effect.void,
	})
	const program = adapter.prepare(invocation('x'))
	expect(events).toEqual([])
	const exit = await Effect.runPromiseExit(program)
	expect(exit._tag).toBe('Failure')
	if (exit._tag === 'Failure') expect(exit.cause.reasons[0]?._tag).toBe('Die')
	expect(events).toEqual(['authorize', 'lookup', 'claim'])
})
it('copies trusted identity and versions and isolates reused/nested invocation captures', async () => {
	const identity = { operation: 'save', scope: 'tenant:principal', key: 'retry' }
	const mutableVersions = { ...versions }
	const capture = captureIdempotencyInvocation({
		binding: { kind: 'mutation', atomicity: 'same-mutation' },
		identity,
		versions: mutableVersions,
		rawInput: 'outer',
		canonical: { bounds },
	})
	identity.scope = 'changed'
	mutableVersions.contract = 'changed'
	expect(capture.identity.scope).toBe('tenant:principal')
	expect(capture.versions.contract).toBe('1')
	const h = ledger()
	const outer = await h.adapter.prepare(capture)
	const nested = await h.adapter.prepare(invocation('inner', 'nested-scope'))
	if (nested.kind === 'execute') await nested.complete(2)
	if (outer.kind === 'execute') await outer.complete(1)
	expect(await h.adapter.prepare(invocation('outer'))).toEqual({ kind: 'replay', result: '1' })
	expect(await h.adapter.prepare(invocation('inner', 'nested-scope'))).toEqual({
		kind: 'replay',
		result: '2',
	})
})
it('allows normalized equivalence only through explicit versioned deterministic policy', async () => {
	const h = ledger()
	const capture = (rawInput: string) =>
		captureIdempotencyInvocation({
			binding: { kind: 'mutation', atomicity: 'same-mutation' },
			identity: { operation: 'save', scope: 'tenant:principal', key: 'retry' },
			versions: { ...versions, fingerprintPolicy: 'trim-v1' },
			rawInput,
			canonical: { bounds, normalize: (raw) => String(raw).trim() },
		})
	const fresh = await h.adapter.prepare(capture(' abc '))
	if (fresh.kind === 'execute') await fresh.complete(3)
	expect(await h.adapter.prepare(capture('abc'))).toEqual({ kind: 'replay', result: '3' })
	expect(h.rows.size).toBe(1)
})
it('lifecycle stores already transformed output after audit and replay validates final wire only', async () => {
	class DecoderPrefix extends Context.Service<DecoderPrefix, string>()('IdempotencyDecoderPrefix') {}
	const rows: IdempotencyReceipt[] = []
	const events: string[] = []
	const decodedInputs: string[] = []
	let transformCount = 0
	let decodeCount = 0
	const replayResult = zodContract(
		z.string().transform((wire) => {
			decodeCount++
			return { label: wire }
		}),
	)
	const adapter = effectTransactionalIdempotency({
		final: {
			replayResult,
			encode: (result: { label: string }) => {
				events.push('encode')
				return result.label
			},
		},
		authorize: () => {
			events.push('authorize')
		},
		lookup: () => rows,
		fingerprint: (bytes) => bytes,
		claim: (_identity, receipt) => {
			rows.push(receipt)
			return 0
		},
		complete: (index: number, receipt) => {
			events.push('complete')
			rows[index] = receipt
		},
	})
	const create = bindEffectCommand({
		observability: new Observability({
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
		}),
		checkPermission: () => undefined,
		writeAudit: () => {
			events.push('write-audit')
		},
	})
	const registry = create({
		context: (host: { capture: ReturnType<typeof invocation> }) => host,
		operations: ({ command }) => ({
			save: command({
				input: effectContract<string, string, never, DecoderPrefix>((raw) =>
					Effect.gen(function* () {
						const prefix = yield* DecoderPrefix
						const input = prefix + z.string().parse(raw).trim()
						decodedInputs.push(input)
						return input
					}),
				),
				result: z.string().transform((label) => {
					transformCount++
					return { label: label + '!' }
				}),
				replayResult: adapter.replayResult,
				prepare: (context) => adapter.prepare(context.capture),
				classification: 'business',
				handler: (input) => {
					events.push('handler')
					return input
				},
				audit: () => {
					events.push('audit')
					return null
				},
			}),
		}),
	})
	const run = (raw: string, prefix: string) =>
		Effect.runPromise(
			registry.exec('save', raw, { capture: invocation(raw) }).pipe(
				Effect.provideService(DecoderPrefix, prefix),
			),
		)
	expect(await run(' abc ', 'first:')).toEqual({ label: 'first:abc!' })
	expect(decodedInputs).toEqual(['first:abc'])
	expect(rows[0]?.result).toBe('first:abc!')
	expect(events).toEqual(['authorize', 'handler', 'audit', 'encode', 'complete'])
	events.length = 0
	expect(await run(' abc ', 'changed-service:')).toEqual({ label: 'first:abc!' })
	expect(decodedInputs).toEqual(['first:abc', 'changed-service:abc'])
	expect(events).toEqual(['authorize'])
	expect(transformCount).toBe(1)
	expect(decodeCount).toBe(1)
	await expect(run('abc', 'changed-service:')).rejects.toThrow('different input')
	expect(decodedInputs).toEqual(['first:abc', 'changed-service:abc', 'changed-service:abc'])
	expect(transformCount).toBe(1)
	rows[0] = { ...rows[0]!, result: 99 }
	await expect(run(' abc ', 'changed-service:')).rejects.toThrow()
	expect(decodedInputs).toEqual([
		'first:abc',
		'changed-service:abc',
		'changed-service:abc',
		'changed-service:abc',
	])
	expect(transformCount).toBe(1)
})
it('Effect protocol failures are typed, explicit callback failures stay typed and Promise rejection is a defect', async () => {
	class Denied {
		readonly _tag = 'Denied'
	}
	const adapter = (authorize: () => void | Promise<void> | Effect.Effect<void, Denied>) =>
		effectTransactionalIdempotency({
			final: { replayResult: zodContract(z.number()), encode: (n: number) => n },
			authorize,
			lookup: () => [{ versions, fingerprint: 'other', state: 'completed', result: 1 }],
			fingerprint: (bytes) => bytes,
			claim: () => 0,
			complete: () => undefined,
		})
	for (const [policy, tag] of [
		[() => undefined, 'Fail'],
		[() => Effect.fail(new Denied()), 'Fail'],
		[() => Promise.reject(Error('rejected')), 'Die'],
	] as const) {
		const exit = await Effect.runPromiseExit(adapter(policy).prepare(invocation('x')))
		expect(exit._tag).toBe('Failure')
		if (exit._tag === 'Failure') expect(exit.cause.reasons[0]?._tag).toBe(tag)
	}
})
it('preserves valid __proto__ fields in canonical input identity', () => {
	const value = JSON.parse('{"__proto__":{"flag":1},"title":"x"}')
	expect(canonicalConvexBytes(value, bounds)).not.toBe(canonicalConvexBytes({ title: 'x' }, bounds))
	expect(canonicalConvexBytes({ nested: value }, bounds)).not.toBe(
		canonicalConvexBytes({ nested: { title: 'x' } }, bounds),
	)
})
it('propagates final encoding failure before writing a completed receipt', async () => {
	class EncodingFailure {
		readonly _tag = 'EncodingFailure'
	}
	const policies: ReadonlyArray<
		readonly [() => Effect.Effect<never, EncodingFailure> | Promise<never>, 'Fail' | 'Die']
	> = [
		[() => Effect.fail(new EncodingFailure()), 'Fail'],
		[() => Promise.reject(Error('private encoding rejection')), 'Die'],
	]
	for (const [encode, expected] of policies) {
		let completed = 0
		const adapter = effectTransactionalIdempotency({
			final: { replayResult: zodContract(z.number()), encode },
			authorize: () => undefined,
			lookup: () => [],
			fingerprint: (bytes) => bytes,
			claim: () => 0,
			complete: () => {
				completed++
			},
		})
		const preparation = await Effect.runPromise(adapter.prepare(invocation('value')))
		expect(preparation.kind).toBe('execute')
		if (preparation.kind !== 'execute') throw Error('Expected fresh execution')
		const exit = await Effect.runPromiseExit(preparation.complete(1))
		expect(exit._tag).toBe('Failure')
		if (exit._tag === 'Failure') {
			expect(exit.cause.reasons[0]?._tag).toBe(expected)
			if (exit.cause.reasons[0]?._tag === 'Fail')
				expect(exit.cause.reasons[0].error).toBeInstanceOf(EncodingFailure)
		}
		expect(completed).toBe(0)
	}
})
