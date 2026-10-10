import { makeFunctionReference } from 'convex/server'
import { Effect } from 'effect'
import { expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { defineDomainContract } from '../src/contracts'
import { createFoundation } from '../src/index'
import { createEffectFoundation } from '../src/effect'
import {
	bindOperationExecutor,
	createOperationTools,
	operationToolDialect,
} from '../src/agent-tools'
import {
	workflowBinding,
	workflowExecution,
	runWorkflowStep,
	type WorkflowStepArguments,
	type WorkflowStepRunner,
} from '../src/workflow'
for (const effect of [false, true]) {
	it(`${effect ? 'Effect' : 'Promise'} contracted operations compose with agent and workflow adapters`, async () => {
		let transforms = 0
		const raw = z.object({ value: z.string() }).strict()
		const contract = defineDomainContract({
			commands: {
				save: {
					input: raw.transform((input) => {
						transforms++
						return { value: Number(input.value) }
					}),
					result: z.number(),
					classification: 'business',
				},
			},
		})
		const options = {
			observability: {
				enabled: false,
				classifyError: () => ({ outcome: 'failed' as const, errorCode: 'FAIL' }),
			},
			writeAudit: () => undefined,
		}
		const normal = createFoundation(options).Command({
			contract,
			context: (host: { actor: string }) => host,
			audit: () => null,
			operations: ({ command }) => ({
				save: command.save({ handler: (input) => input.value + 1 }),
			}),
		})
		const optional = createEffectFoundation(options).Command({
			contract,
			context: (host: { actor: string }) => host,
			audit: () => null,
			operations: ({ command }) => ({
				save: command.save({ handler: (input) => input.value + 1 }),
			}),
		})
		const owner = Symbol('tasks')
		const selected = effect ? optional.expose(owner, 'save') : normal.expose(owner, 'save')
		const execute = (input: z.input<typeof raw>) =>
			effect
				? Effect.runPromise(optional.exec('save', input, { actor: 'a' }))
				: normal.exec('save', input, { actor: 'a' })
		const executor = bindOperationExecutor(selected, { owner, key: 'save', execute })
		const tools = createOperationTools({
			save: {
				operation: selected,
				executor,
				description: 'Save task',
				converter: {
					dialect: operationToolDialect,
					convert: () => ({
						type: 'object',
						properties: { value: { type: 'string' } },
						required: ['value'],
						additionalProperties: false,
					}),
				},
			},
		})
		expect(transforms).toBe(0)
		expect(await tools.save.invoke({ value: '2' })).toEqual({ _tag: 'Success', value: 3 })
		expect(transforms).toBe(1)
		const metadata = {
			operation: 'save',
			operationVersion: '1',
			contractVersion: '1',
			bindingVersion: '1',
		}
		const binding = workflowBinding({
			...metadata,
			kind: 'mutation',
			args: selected.input,
			result: contract.commands.save.result,
			reference: makeFunctionReference<
				'mutation',
				WorkflowStepArguments<z.input<typeof raw>>,
				number
			>('tasks:save'),
		})
		const descriptor = workflowExecution({
			...metadata,
			version: 1,
			run: 'run',
			capability: 'host-capability',
			occurrence: 'save:0',
			args: { value: '4' },
		})
		const runner: WorkflowStepRunner = {
			runMutation: (_reference, { execution }) => execute(raw.parse(execution.args)),
		}
		const result = await runWorkflowStep(runner, binding, descriptor)
		expect(result).toBe(5)
		expect(transforms).toBe(2)
		expect(binding.args).toBe(contract.commands.save.input)
	})
}
