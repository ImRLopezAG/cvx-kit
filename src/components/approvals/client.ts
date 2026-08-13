import type {
	FunctionArgs,
	FunctionReference,
	FunctionReturnType,
	GenericDataModel,
	GenericMutationCtx,
	GenericQueryCtx,
} from 'convex/server'

import type { ComponentApi } from './_generated/component'
import type { ApprovalDecision } from './constants'
import type {
	ApprovalActor,
	ApprovalMetadata,
	ApprovalWorkflowDescriptor,
} from './validators'
import {
	compileApprovalDescriptor,
	type ApprovalActionStep,
	type ApprovalBranchStep,
	type ApprovalDecisionStep,
	type ApprovalDefinition,
	type ApprovalMutationStep,
	type ApprovalNotifyStep,
	type ApprovalWorkflowStep,
	type ApprovalCallbackInput,
	type CreateApprovalHandle,
} from './workflow_steps'

export type ApprovalsOptions = Readonly<{
	createHandle?: CreateApprovalHandle
}>

export type ApprovalStartInput = Readonly<{
	scopeRef: string
	resourceType: string
	resourceRef: string
	requester: ApprovalActor
	metadata?: ApprovalMetadata
}>

export type ApprovalDecisionInput = Readonly<{
	runId: string
	decision: ApprovalDecision
	reason?: string
}>

export type ApprovalEvidenceItem = Readonly<{
	stepKey: string
	actorRef: string
	decision: ApprovalDecision
	reason?: string
	decidedAt: number
}>

export type ApprovalAuditHistoryInput = Readonly<{
	resourceType: string
	resourceRef: string
	limit?: number
}>

export type ApprovalAuditCleanupInput = Readonly<{
	olderThanDays: number
	batchSize: number
}>

export type ApprovalStatus = FunctionReturnType<
	ComponentApi['requests']['status']
>

export class Approvals<Component extends ComponentApi = ComponentApi> {
	private readonly component: Component
	private readonly createHandle: CreateApprovalHandle | undefined

	constructor(component: Component, options: ApprovalsOptions = {}) {
		this.component = component
		this.createHandle = options.createHandle
	}

	cleanupAudit<DataModel extends GenericDataModel>(
		ctx: GenericMutationCtx<DataModel>,
		input: ApprovalAuditCleanupInput,
	): Promise<FunctionReturnType<Component['audit']['cleanup']>> {
		return ctx.runMutation(this.component.audit.cleanup, input)
	}

	mutation(
		key: string,
		options: Readonly<{
			handler: FunctionReference<
				'mutation',
				'internal',
				ApprovalCallbackInput,
				unknown
			>
			retry?: boolean
		}>,
	): ApprovalMutationStep {
		return Object.freeze({
			kind: 'mutation',
			key,
			handler: options.handler,
			retry: options.retry ?? false,
		})
	}

	action(
		key: string,
		options: Readonly<{
			handler: FunctionReference<
				'action',
				'internal',
				ApprovalCallbackInput,
				unknown
			>
			retry?: boolean
		}>,
	): ApprovalActionStep {
		return Object.freeze({
			kind: 'action',
			key,
			handler: options.handler,
			retry: options.retry ?? false,
		})
	}

	notify(
		key: string,
		options: Readonly<{
			handler: FunctionReference<
				'action',
				'internal',
				ApprovalCallbackInput,
				unknown
			>
			retry?: boolean
		}>,
	): ApprovalNotifyStep {
		return Object.freeze({
			kind: 'notify',
			key,
			handler: options.handler,
			retry: options.retry ?? false,
		})
	}

	decision(
		key: string,
		options: Readonly<{
			decisions: readonly ApprovalDecision[]
			quorum: Readonly<{ kind: 'count'; approvals: number }>
			makerChecker?: boolean
			expiresAfterMs?: number
		}>,
	): ApprovalDecisionStep {
		return Object.freeze({
			kind: 'decision',
			key,
			decisions: Object.freeze([...options.decisions]),
			quorum: Object.freeze({ ...options.quorum }),
			makerChecker: options.makerChecker ?? false,
			...(options.expiresAfterMs === undefined
				? {}
				: { expiresAfterMs: options.expiresAfterMs }),
		})
	}

	branch(
		key: string,
		options: Readonly<{
			approvedStepKey: string
			rejectedStepKey: string
		}>,
	): ApprovalBranchStep {
		return Object.freeze({ kind: 'branch', key, ...options })
	}

	define(
		input: Readonly<{
			name: string
			compatibilityKey?: string
			steps: readonly ApprovalWorkflowStep[]
		}>,
	): ConfiguredApprovalWorkflow<Component> {
		const definition = freezeDefinition({
			name: input.name,
			compatibilityKey: input.compatibilityKey ?? input.name,
			steps: input.steps,
		})
		return new ConfiguredApprovalWorkflow(
			this.component,
			definition,
			this.createHandle,
		)
	}
}

export class ConfiguredApprovalWorkflow<
	Component extends ComponentApi = ComponentApi,
> {
	readonly name: string
	readonly compatibilityKey: string
	readonly steps: readonly ApprovalWorkflowStep[]

	private readonly component: Component
	private readonly definition: ApprovalDefinition
	private readonly createHandle: CreateApprovalHandle | undefined

	constructor(
		component: Component,
		definition: ApprovalDefinition,
		createHandle?: CreateApprovalHandle,
	) {
		this.component = component
		this.definition = definition
		this.name = definition.name
		this.compatibilityKey = definition.compatibilityKey
		this.steps = definition.steps
		this.createHandle = createHandle
		Object.freeze(this)
	}

	descriptor(): Promise<Readonly<ApprovalWorkflowDescriptor>> {
		return compileApprovalDescriptor(this.definition, this.createHandle)
	}

	async start<DataModel extends GenericDataModel>(
		ctx: GenericMutationCtx<DataModel>,
		input: ApprovalStartInput,
	): Promise<FunctionReturnType<Component['requests']['start']>> {
		return ctx.runMutation(this.component.requests.start, {
			...input,
			workflow: await this.descriptor(),
		})
	}

	decide<DataModel extends GenericDataModel>(
		ctx: GenericMutationCtx<DataModel>,
		input: ApprovalDecisionInput,
		actor: ApprovalActor,
	): Promise<FunctionReturnType<Component['decisions']['decide']>> {
		return ctx.runMutation(this.component.decisions.decide, {
			...input,
			actor,
			compatibilityKey: this.compatibilityKey,
		})
	}

	evidence<DataModel extends GenericDataModel>(
		ctx: GenericQueryCtx<DataModel>,
		runId: string,
	): Promise<FunctionReturnType<Component['decisions']['list']>> {
		return ctx.runQuery(this.component.decisions.list, { runId })
	}

	auditHistory<DataModel extends GenericDataModel>(
		ctx: GenericQueryCtx<DataModel>,
		input: ApprovalAuditHistoryInput,
	): Promise<FunctionReturnType<Component['audit']['history']>> {
		return ctx.runQuery(this.component.audit.history, input)
	}

	cancel<DataModel extends GenericDataModel>(
		ctx: GenericMutationCtx<DataModel>,
		runId: string,
		actor: ApprovalActor,
	): Promise<FunctionReturnType<Component['requests']['cancel']>> {
		return ctx.runMutation(this.component.requests.cancel, {
			runId,
			actor,
			compatibilityKey: this.compatibilityKey,
		})
	}

	status<DataModel extends GenericDataModel>(
		ctx: GenericQueryCtx<DataModel>,
		runId: string,
	): Promise<ApprovalStatus | null> {
		return ctx.runQuery(this.component.requests.status, {
			runId,
			compatibilityKey: this.compatibilityKey,
		})
	}

	list<DataModel extends GenericDataModel>(
		ctx: GenericQueryCtx<DataModel>,
		input: FunctionArgs<Component['requests']['list']>,
	): Promise<FunctionReturnType<Component['requests']['list']>> {
		return ctx.runQuery(this.component.requests.list, input)
	}

	restart<DataModel extends GenericDataModel>(
		ctx: GenericMutationCtx<DataModel>,
		runId: string,
	): Promise<FunctionReturnType<Component['requests']['restart']>> {
		return ctx.runMutation(this.component.requests.restart, {
			runId,
			compatibilityKey: this.compatibilityKey,
		})
	}
}

function freezeDefinition(definition: ApprovalDefinition): ApprovalDefinition {
	return Object.freeze({
		...definition,
		steps: Object.freeze(
			definition.steps.map((step) => {
				if (step.kind === 'decision')
					return Object.freeze({
						...step,
						decisions: Object.freeze([...step.decisions]),
						quorum: Object.freeze({ ...step.quorum }),
					})
				return Object.freeze({ ...step })
			}),
		),
	})
}
