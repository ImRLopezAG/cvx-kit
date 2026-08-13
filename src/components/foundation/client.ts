import { Command } from './modules/command/command'
import {
	Observability,
	type ObservabilityOptions,
} from './modules/observability/observability'
import { Query } from './modules/query/query'

export type FoundationOptions = Readonly<{
	observability: ObservabilityOptions
}>

type FoundationComponentApi = Readonly<{
	functions: Readonly<{ status: unknown }>
}>

/** Host facade for a component that owns no application execution capability. */
export class Foundation<
	Component extends FoundationComponentApi = FoundationComponentApi,
> {
	readonly status: Component['functions']['status']
	readonly Command = Command
	readonly Query = Query
	readonly observability: Observability

	constructor(component: Component, options: FoundationOptions) {
		this.status = component.functions.status
		this.observability = new Observability(options.observability)
	}
}

export { Command } from './modules/command/command'
export type {
	Command as CommandKernel,
	CommandExecution,
	CommandInput,
	CommandRegistry,
	CommandResult,
	Parseable,
} from './modules/command/command'
export { Observability } from './modules/observability/observability'
export type {
	CommandObservation,
	ObservabilityOptions,
} from './modules/observability/observability'
export { Query } from './modules/query/query'
export type { QueryExecution } from './modules/query/query'
export { executeResultBoundary, projectResult } from './result'
export type {
	Result,
	ResultBoundary,
	TransactionMetricsContext,
} from './result'
export { emitSemanticEvent } from './telemetry'
