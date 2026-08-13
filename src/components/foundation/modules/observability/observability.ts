export type CommandObservation = Readonly<{
	operation: string
	classification: string
	outcome: 'completed' | 'denied' | 'failed'
	errorCode?: string
	durationMs: number
}>

export type ObservabilityOptions = Readonly<{
	enabled?: boolean | (() => boolean)
	classifyError: (error: unknown) => Readonly<{
		outcome: 'denied' | 'failed'
		errorCode: string
	}>
	emit?: (observation: CommandObservation) => void
	clock?: () => number
}>

const identifier = /^[A-Za-z][A-Za-z0-9_.-]{0,159}$/
const errorCode = /^[A-Z][A-Z0-9_]{0,95}$/

/** Payload-free command telemetry that cannot change command behavior. */
export class Observability {
	readonly #options: ObservabilityOptions

	constructor(options: ObservabilityOptions) {
		this.#options = options
	}

	async observe<Result>(
		activation: Readonly<{ operation: string; classification: string }>,
		execute: () => Result | Promise<Result>,
	): Promise<Result> {
		const started = this.#now()
		try {
			const result = await execute()
			this.#emit({
				...activation,
				outcome: 'completed',
				durationMs: this.#duration(started),
			})
			return result
		} catch (error) {
			try {
				this.#emit({
					...activation,
					...this.#options.classifyError(error),
					durationMs: this.#duration(started),
				})
			} catch {
				// Preserve the original command failure when telemetry fails.
			}
			throw error
		}
	}

	#emit(observation: CommandObservation): void {
		try {
			const enabled =
				typeof this.#options.enabled === 'function'
					? this.#options.enabled()
					: this.#options.enabled
			if (
				enabled !== true ||
				!identifier.test(observation.operation) ||
				!identifier.test(observation.classification) ||
				(observation.errorCode !== undefined &&
					!errorCode.test(observation.errorCode))
			) {
				return
			}
			if (this.#options.emit) {
				this.#options.emit(Object.freeze(observation))
				return
			}
			console.info(
				JSON.stringify({ event: 'command.execution', ...observation }),
			)
		} catch {
			// Observability is intentionally behaviorally inert.
		}
	}

	#now(): number {
		try {
			return this.#options.clock?.() ?? Date.now()
		} catch {
			return Date.now()
		}
	}

	#duration(started: number): number {
		return Math.max(0, Math.min(600_000, this.#now() - started))
	}
}
