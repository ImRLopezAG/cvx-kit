import { describe, expect, it } from 'vite-plus/test'
import { makeFunctionReference } from 'convex/server'
import { z } from 'zod'
import { zodContract } from '../src/contracts'
import {
	workflowBinding,
	runWorkflowStep,
	workflowExecution,
	workflowAttempt,
	terminalWorkflowAttempt,
	workflowReceiptInvocation,
	receiptWorkflowMutation,
	workflowTransition,
	workflowRestart,
	workflowCancel,
	workflowStatusBindings,
	type WorkflowHostState,
	type WorkflowStepRunner,
} from '../src/modules/contracts/workflow'
import { transactionalIdempotency } from '../src/modules/contracts/idempotency'
import { Context, Effect, Exit } from 'effect'
import { effectTransactionalIdempotency } from '../src/modules/effect/idempotency'
import {
	effectWorkflowAttempt,
	effectReceiptWorkflowMutation,
	effectTerminalWorkflowAttempt,
	effectWorkflowStatusBindings,
} from '../src/modules/effect/workflow'

const metadata = {
	operation: 'save',
	operationVersion: '1',
	contractVersion: '1',
	bindingVersion: '1',
}
const args = zodContract(z.object({ value: z.number() }).strict())
const result = zodContract(z.number())
const descriptor = () =>
	workflowExecution({
		...metadata,
		version: 1,
		run: 'run',
		capability: 'cap',
		occurrence: 'save:0',
		args: { value: 2 },
	})
const bounds = {
	maxDepth: 20,
	maxNodes: 1000,
	maxBytes: 10000,
	maxArrayLength: 100,
	maxObjectFields: 100,
}

describe('workflow transport and native dispatch (unit seams, not component acceptance)', () => {
	it('captures stable binding metadata independently of later caller mutation', () => {
		const definition = {
			...metadata,
			kind: 'mutation' as const,
			args,
			result,
			reference: makeFunctionReference<
				'mutation',
				{ execution: ReturnType<typeof descriptor> },
				number
			>('steps:snapshot'),
			compatibleVersions: [
				{ operationVersion: 'old', contractVersion: 'old', bindingVersion: 'old' },
			],
		}
		const binding = workflowBinding(definition)
		definition.bindingVersion = '2'
		definition.compatibleVersions[0].bindingVersion = '2'
		expect(binding.bindingVersion).toBe('1')
		expect(binding.compatibleVersions?.[0].bindingVersion).toBe('old')
	})
	it('keeps wire transforms inside executed native invocations, including journal replay', async () => {
		let decoded = 0
		const transformedArgs = zodContract(
			z.object({ value: z.number() }).transform((value) => {
				decoded++
				return String(value.value)
			}),
		)
		const transformedResult = zodContract(
			z.number().transform((value) => {
				decoded++
				return String(value)
			}),
		)
		const binding = workflowBinding({
			...metadata,
			kind: 'mutation',
			args: transformedArgs,
			result: transformedResult,
			reference: makeFunctionReference<
				'mutation',
				{ execution: ReturnType<typeof descriptor> },
				number
			>('steps:transform'),
		})
		const step = { runMutation: async () => 4 }
		expect(await runWorkflowStep(step, binding, descriptor())).toBe(4)
		expect(await runWorkflowStep(step, binding, descriptor())).toBe(4)
		expect(decoded).toBe(0)
	})
	it('requires exact plain descriptor fields and explicit compatible versions', async () => {
		for (const value of [
			{ ...descriptor(), version: 2 },
			{ ...descriptor(), principal: 'caller' },
			{ ...descriptor(), args: new Date() },
			{ ...descriptor(), occurrence: '' },
		])
			expect(() => workflowExecution(value)).toThrow()
		const binding = workflowBinding({
			...metadata,
			kind: 'mutation',
			args,
			result,
			reference: makeFunctionReference<
				'mutation',
				{ execution: ReturnType<typeof descriptor> },
				number
			>('steps:raw'),
		})
		let calls = 0
		const step = {
			runMutation: async () => {
				calls++
				return 4
			},
		}
		await expect(
			runWorkflowStep(step, binding, { ...descriptor(), bindingVersion: 'old' }),
		).rejects.toThrow('version')
		expect(calls).toBe(0)
		await expect(runWorkflowStep(step, binding, descriptor())).resolves.toBe(4)
		await expect(
			runWorkflowStep(
				{
					runMutation: async () => {
						throw Error('raw failure')
					},
				},
				binding,
				descriptor(),
			),
		).rejects.toThrow('raw failure')
	})
	it('overrides enabled native action defaults and permits explicit retry options', async () => {
		const binding = workflowBinding({
			...metadata,
			kind: 'action',
			args,
			result,
			reference: makeFunctionReference<
				'action',
				{ execution: ReturnType<typeof descriptor> },
				number
			>('steps:action'),
		})
		const retries: unknown[] = []
		const step: WorkflowStepRunner = {
			runAction: async (_reference, _args, options = {}) => {
				retries.push(options.retry ?? true)
				return 4
			},
		}
		await runWorkflowStep(step, binding, descriptor())
		await runWorkflowStep(step, binding, descriptor(), { retry: true })
		expect(retries).toEqual([false, true])
	})
	it('reconstructs authority and services on every executed attempt; replay is native responsibility', async () => {
		let revoked = false
		let authorityCalls = 0
		const attempt = workflowAttempt({
			authorize: (execution: ReturnType<typeof descriptor>) => {
				authorityCalls++
				expect(execution.capability).toBe('cap')
				if (revoked) throw Error('revoked')
				return { service: authorityCalls }
			},
			execute: (execution, authority) => execution.args.value + authority.service,
		})
		expect(await attempt(descriptor())).toBe(3)
		expect(await attempt(descriptor())).toBe(4)
		revoked = true
		await expect(attempt(descriptor())).rejects.toThrow('revoked')
		expect(authorityCalls).toBe(3)
	})
	it('maps declared error objects after the separate inner call rejects and leaves transient errors thrown', async () => {
		const events: string[] = []
		const failure = { code: 'declined', details: { reason: 'limit' } }
		const attempt = terminalWorkflowAttempt({
			kind: 'mutation',
			atomicJournalProof: 'host-verified',
			authorize: () => 'trusted',
			invokeMutation: async () => {
				events.push('rejected-inner')
				throw failure
			},
			terminal: (error) => {
				events.push('mapped')
				return error === failure ? failure : undefined
			},
			result,
			failure: zodContract(
				z.object({ code: z.string(), details: z.object({ reason: z.string() }) }),
			),
		})
		expect(await attempt(descriptor())).toEqual({ version: 1, kind: 'failed', error: failure })
		expect(events).toEqual(['rejected-inner', 'mapped'])
		const transient = terminalWorkflowAttempt({
			kind: 'mutation',
			atomicJournalProof: 'host-verified',
			authorize: () => 'trusted',
			invokeMutation: async () => {
				throw Error('transient')
			},
			terminal: () => undefined,
			result,
			failure: zodContract(z.string()),
		})
		await expect(transient(descriptor())).rejects.toThrow('transient')
	})
	for (const mode of ['neutral', 'Effect'] as const) {
		it(`${mode} journals only decoded terminal fields, stripping unknown secrets`, async () => {
			const failure = {
				code: 'declined',
				details: { reason: 'limit', providerSecret: 'private' },
				stack: 'private stack',
			}
			const configuration = {
				kind: 'mutation' as const,
				atomicJournalProof: 'host-verified' as const,
				authorize: () => 'trusted',
				invokeMutation: async () => {
					throw Error('native rejection')
				},
				terminal: () => failure,
				result,
				failure: zodContract(
					z.object({ code: z.string(), details: z.object({ reason: z.string() }) }),
				),
			}
			const outcome =
				mode === 'neutral'
					? await terminalWorkflowAttempt(configuration)(descriptor())
					: await Effect.runPromise(effectTerminalWorkflowAttempt(configuration)(descriptor()))
			expect(outcome).toEqual({
				version: 1,
				kind: 'failed',
				error: { code: 'declined', details: { reason: 'limit' } },
			})
		})
		it(`${mode} returns the transformed safe terminal DTO and decodes exactly once`, async () => {
			let decodes = 0
			const configuration = {
				kind: 'mutation' as const,
				atomicJournalProof: 'host-verified' as const,
				authorize: () => 'trusted',
				invokeMutation: async () => {
					throw Error('native rejection')
				},
				terminal: () => ({ providerCode: 402, secret: 'private' }),
				result,
				failure: zodContract(
					z.object({ providerCode: z.number() }).transform(() => {
						decodes++
						return { code: 'declined' as const, reason: 'limit' }
					}),
				),
			}
			const outcome =
				mode === 'neutral'
					? await terminalWorkflowAttempt(configuration)(descriptor())
					: await Effect.runPromise(effectTerminalWorkflowAttempt(configuration)(descriptor()))
			expect(outcome).toEqual({
				version: 1,
				kind: 'failed',
				error: { code: 'declined', reason: 'limit' },
			})
			expect(decodes).toBe(1)
		})
		it(`${mode} rejects an unserializable decoded terminal value`, async () => {
			let decodes = 0
			const configuration = {
				kind: 'mutation' as const,
				atomicJournalProof: 'host-verified' as const,
				authorize: () => 'trusted',
				invokeMutation: async () => {
					throw Error('native rejection')
				},
				terminal: () => 'declined',
				result,
				failure: zodContract(
					z.string().transform(() => {
						decodes++
						return new Date(0)
					}),
				),
			}
			const outcome =
				mode === 'neutral'
					? terminalWorkflowAttempt(configuration)(descriptor())
					: Effect.runPromise(effectTerminalWorkflowAttempt(configuration)(descriptor()))
			await expect(outcome).rejects.toThrow()
			expect(decodes).toBe(1)
		})
	}
	it('keeps repeated occurrences distinct while generation and attempts never enter receipt identity', () => {
		const identity = (execution: ReturnType<typeof descriptor>) =>
			workflowReceiptInvocation(execution, {
				scope: 'tenant:actor',
				fingerprintPolicy: 'raw',
				bounds,
			}).identity
		expect(identity(descriptor())).toEqual({
			operation: 'save',
			scope: 'tenant:actor',
			key: '["run","save:0"]',
		})
		expect(identity({ ...descriptor(), occurrence: 'save:1' }).key).not.toBe(
			identity(descriptor()).key,
		)
		expect(
			workflowReceiptInvocation(
				{ ...descriptor(), bindingVersion: '2' },
				{ scope: 'tenant:actor', fingerprintPolicy: 'raw', bounds },
			).identity,
		).toEqual(identity(descriptor()))
	})
	it('protects the inner mutation with U5 receipt replay and current authorization', async () => {
		const rows: unknown[] = []
		let writes = 0
		let revoked = false
		const receipt = transactionalIdempotency({
			final: { replayResult: result, encode: (n: number) => n },
			authorize: () => {
				if (revoked) throw Error('revoked')
			},
			lookup: () => rows,
			fingerprint: (s) => s,
			claim: (_i, row) => {
				rows.push(row)
				return 0
			},
			complete: (index, row) => {
				rows[index] = row
			},
		})
		const protectedMutation = receiptWorkflowMutation({
			authorize: () => {
				if (revoked) throw Error('revoked')
				return { scope: 'tenant:actor' }
			},
			receipt: () => receipt,
			invocation: (execution, authority) =>
				workflowReceiptInvocation(execution, {
					scope: authority.scope,
					fingerprintPolicy: 'raw',
					bounds,
				}),
			execute: () => ++writes,
		})
		expect(await protectedMutation.handler(descriptor())).toBe(1)
		expect(await protectedMutation.handler(descriptor())).toBe(1)
		expect(writes).toBe(1)
		// Unit-only lost-response model: the host/native gate must prove this transaction boundary.
		const lostResponse = async () => {
			await protectedMutation.handler(descriptor())
			throw Error('lost action response')
		}
		await expect(lostResponse()).rejects.toThrow('lost action response')
		expect(await protectedMutation.handler(descriptor())).toBe(1)
		await expect(
			protectedMutation.handler({ ...descriptor(), bindingVersion: '2' }),
		).rejects.toThrow('version')
		expect(writes).toBe(1)
		revoked = true
		await expect(protectedMutation.handler(descriptor())).rejects.toThrow('revoked')
		expect(writes).toBe(1)
	})
	it('executes Effect receipt completion once and decodes retained wire data on authorized replay', async () => {
		class Completion extends Context.Service<Completion, string>()('WorkflowReceiptCompletion') {}
		const rows: unknown[] = []
		let executions = 0
		let completions = 0
		let decodes = 0
		let authorizations = 0
		let lookups = 0
		let allowed = true
		const denied = { _tag: 'WorkflowAuthorityDenied' as const }
		const replay = zodContract(
			z.string().transform((wire) => {
				decodes++
				return Number(wire)
			}),
		)
		const receipt = effectTransactionalIdempotency({
			final: { replayResult: replay, encode: (value: number) => String(value) },
			authorize: () => Effect.void,
			lookup: () =>
				Effect.sync(() => {
					lookups++
					return rows
				}),
			fingerprint: (bytes) => bytes,
			claim: (_identity, retained) =>
				Effect.sync(() => {
					rows.push(retained)
					return rows.length - 1
				}),
			complete: (index, retained) =>
				Completion.pipe(
					Effect.map((service) => {
						expect(service).toBe('trusted-completion')
						completions++
						rows[index] = retained
					}),
				),
		})
		const protectedMutation = effectReceiptWorkflowMutation({
			authorize: () =>
				Effect.suspend(() => {
					authorizations++
					return allowed ? Effect.succeed({ scope: 'tenant:actor' }) : Effect.fail(denied)
				}),
			receipt: () => receipt,
			invocation: (execution, authority) =>
				workflowReceiptInvocation(execution, {
					scope: authority.scope,
					fingerprintPolicy: 'raw',
					bounds,
				}),
			execute: () => Effect.sync(() => ++executions),
		})
		const execution = descriptor()
		const attempt = () =>
			protectedMutation
				.handler(execution)
				.pipe(Effect.provideService(Completion, 'trusted-completion'))
		expect(await Effect.runPromise(attempt())).toBe(1)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ state: 'completed', result: '1' })
		expect(decodes).toBe(0)
		expect(await Effect.runPromise(attempt())).toBe(1)
		expect(decodes).toBe(1)
		expect(executions).toBe(1)
		expect(completions).toBe(1)
		allowed = false
		expect(await Effect.runPromiseExit(attempt())).toEqual(Exit.fail(denied))
		expect(authorizations).toBe(3)
		expect(lookups).toBe(2)
		expect(executions).toBe(1)
		expect(completions).toBe(1)
		expect(decodes).toBe(1)
	})
	it('evaluates the Effect receipt completion service and preserves its typed failure', async () => {
		class Completion extends Context.Service<Completion, string>()('WorkflowReceiptFailure') {}
		const failure = { _tag: 'WorkflowCompletionFailed' as const }
		const services: string[] = []
		let executions = 0
		const receipt = effectTransactionalIdempotency({
			final: { replayResult: result, encode: (value: number) => value },
			authorize: () => Effect.void,
			lookup: () => [],
			fingerprint: (bytes) => bytes,
			claim: () => 0,
			complete: () =>
				Completion.pipe(
					Effect.flatMap((service) => {
						services.push(service)
						return Effect.fail(failure)
					}),
				),
		})
		const protectedMutation = effectReceiptWorkflowMutation({
			authorize: () => Effect.succeed('tenant:actor'),
			receipt: () => receipt,
			invocation: (execution, scope) =>
				workflowReceiptInvocation(execution, {
					scope,
					fingerprintPolicy: 'raw',
					bounds,
				}),
			execute: () => Effect.sync(() => ++executions),
		})
		const exit = await Effect.runPromiseExit(
			protectedMutation
				.handler(descriptor())
				.pipe(Effect.provideService(Completion, 'completion-service')),
		)
		expect(exit).toEqual(Exit.fail(failure))
		expect(services).toEqual(['completion-service'])
		expect(executions).toBe(1)
	})
	it('preserves independent Effect channels and executes fresh authority effects', async () => {
		let count = 0
		const attempt = effectWorkflowAttempt({
			authorize: (_execution: ReturnType<typeof descriptor>) => Effect.sync(() => ++count),
			execute: (execution, authority) => Effect.succeed(execution.args.value + authority),
		})
		expect(await Effect.runPromise(attempt(descriptor()))).toBe(3)
		expect(await Effect.runPromise(attempt(descriptor()))).toBe(4)
	})
})

describe('host workflow projection', () => {
	const running = { generation: 0, status: 'running' as const, nativeStatus: 'running' as const }
	for (const mode of ['ordinary', 'Effect'] as const) {
		for (const order of [
			'failure-before-native-success',
			'failure-after-native-success',
		] as const) {
			it(`${mode} projects retained operation failure as failed ${order}`, async () => {
				let state: WorkflowHostState<number, string> = running
				const outcome = { version: 1 as const, kind: 'failed' as const, error: 'declined' }
				const configuration = {
					authorize: () => undefined,
					read: () => state,
					write: (_expected: number, next: WorkflowHostState<number, string>) => {
						state = next
					},
					nativeStatus: () => 'succeeded' as const,
					receiptOutcome: () => outcome,
					cancelNative: () => undefined,
					restartNative: () => undefined,
				}
				const ordinary = workflowStatusBindings(configuration)
				const effect = effectWorkflowStatusBindings({
					...configuration,
					read: () => Effect.sync(configuration.read),
					write: (expected, next) => Effect.sync(() => configuration.write(expected, next)),
				})
				const callback = (nativeStatus: 'running' | 'succeeded', failure?: typeof outcome) =>
					mode === 'ordinary'
						? ordinary.callback(0, nativeStatus, failure)
						: Effect.runPromise(effect.callback(0, nativeStatus, failure))
				if (order === 'failure-before-native-success') {
					await callback('running', outcome)
					expect(state).toEqual({ ...running, outcome })
					await callback('succeeded')
				} else {
					await callback('succeeded')
					expect(state).toEqual({ generation: 0, status: 'succeeded', nativeStatus: 'succeeded' })
					if (mode === 'ordinary') await ordinary.reconcile(0)
					else await Effect.runPromise(effect.reconcile(0))
				}
				const failed = { generation: 0, status: 'failed', nativeStatus: 'succeeded', outcome }
				expect(state).toEqual(failed)
				await callback('succeeded')
				await callback('running')
				expect(state, 'Repeated or stale running callbacks cannot undo terminal failure').toEqual(
					failed,
				)
			})
		}
	}
	it('fences canceled/restarted generations and keeps committed outcome separate from native failure', () => {
		const canceled = workflowCancel(running, 0).state
		expect(canceled.status).toBe('canceled')
		const outcome = { version: 1 as const, kind: 'succeeded' as const, value: 9 }
		const reconciled = workflowTransition(canceled, {
			generation: 0,
			nativeStatus: 'failed',
			outcome,
		})
		expect(reconciled.state.status).toBe('canceled')
		expect(reconciled.state.outcome).toEqual(outcome)
		expect(reconciled.state.nativeStatus).toBe('failed')
		const restarted = workflowRestart(canceled)
		expect(restarted.generation).toBe(1)
		expect(workflowTransition(restarted, { generation: 0, nativeStatus: 'succeeded' }).kind).toBe(
			'ignored',
		)
		expect(
			workflowTransition(running, { generation: 0, nativeStatus: 'failed', outcome }).state.status,
		).toBe('failed')
		expect(
			workflowTransition(running, {
				generation: 0,
				nativeStatus: 'succeeded',
				outcome: { version: 1, kind: 'failed', error: 'declined' },
			}).state.status,
		).toBe('failed')
	})
	it('repairs callback write failure by authorized reconciliation without declaring receipt success native success', async () => {
		let state: WorkflowHostState<number> = running
		let failWrite = true
		let authorized = 0
		const bindings = workflowStatusBindings({
			authorize: () => {
				authorized++
			},
			read: () => state,
			write: (_expected, next) => {
				if (failWrite) throw Error('callback unavailable')
				state = next
			},
			nativeStatus: () => 'failed' as const,
			receiptOutcome: () => ({ version: 1 as const, kind: 'succeeded' as const, value: 3 }),
			cancelNative: () => undefined,
			restartNative: () => undefined,
		})
		await expect(bindings.callback(0, 'failed')).rejects.toThrow('callback unavailable')
		expect(state.status).toBe('running')
		failWrite = false
		const reconciliation = await bindings.reconcile(0)
		expect(reconciliation.state.status).toBe('failed')
		expect(reconciliation.state.nativeStatus).toBe('failed')
		expect(reconciliation.state.outcome).toEqual({ version: 1, kind: 'succeeded', value: 3 })
		expect(authorized).toBe(2)
	})
	it('runs Effect status callbacks lazily, fences native cancel/restart and retains authority failures', async () => {
		let state: WorkflowHostState<number> = running
		let allowed = true
		let nativeCanceled = 0
		let nativeRestarted = 0
		const bindings = effectWorkflowStatusBindings({
			authorize: () => (allowed ? Effect.void : Effect.fail('revoked')),
			read: () => Effect.succeed(state),
			write: (_expected, next) =>
				Effect.sync(() => {
					state = next
				}),
			nativeStatus: () => Effect.succeed('failed' as const),
			receiptOutcome: () =>
				Effect.succeed({ version: 1 as const, kind: 'succeeded' as const, value: 5 }),
			cancelNative: () =>
				Effect.sync(() => {
					nativeCanceled++
				}),
			restartNative: () =>
				Effect.sync(() => {
					nativeRestarted++
				}),
		})
		const cancel = bindings.cancel(0)
		expect(state.status).toBe('running')
		await Effect.runPromise(cancel)
		expect(state.status).toBe('canceled')
		expect(nativeCanceled).toBe(1)
		await Effect.runPromise(bindings.reconcile(0))
		expect(state.status).toBe('canceled')
		expect(state.nativeStatus).toBe('failed')
		expect(state.outcome).toEqual({ version: 1, kind: 'succeeded', value: 5 })
		await Effect.runPromise(bindings.restart(0))
		expect(state.generation).toBe(1)
		expect(nativeRestarted).toBe(1)
		await Effect.runPromise(bindings.cancel(0))
		expect(nativeCanceled).toBe(1)
		allowed = false
		expect(await Effect.runPromise(bindings.callback(1, 'succeeded').pipe(Effect.flip))).toBe(
			'revoked',
		)
		expect(state.status).toBe('running')
	})
})
