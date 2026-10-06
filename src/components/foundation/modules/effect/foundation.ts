import { Observability, type ObservabilityOptions } from '../observability/observability'
import { bindEffectCommand, type EffectCommandDependencies } from './command'
import { bindEffectQuery } from './query'

/** Shared host capabilities are bound once; registry resolvers stay invocation-local. */
export type EffectFoundationOptions = Omit<EffectCommandDependencies, 'observability'> & {
	observability: ObservabilityOptions
}
export type EffectFoundation<Options extends EffectFoundationOptions> = {
	Command: ReturnType<typeof bindEffectCommand<Options & { observability: Observability }>>
	Query: ReturnType<typeof bindEffectQuery<Options & { observability: Observability }>>
	observability: Observability
}

export function createEffectFoundation<const Options extends EffectFoundationOptions>(
	options: Options,
): EffectFoundation<Options> {
	const observability = new Observability(options.observability)
	const dependencies = { ...options, observability }
	return {
		Command: bindEffectCommand(dependencies),
		Query: bindEffectQuery(dependencies),
		observability,
	}
}
