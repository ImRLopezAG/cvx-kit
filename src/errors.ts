/** Structured application error carried across Convex function boundaries. */
export class KitError extends Error {
	readonly code: string

	constructor(input: { code: string; message?: string }) {
		super(input.message ?? input.code)
		this.name = 'KitError'
		this.code = input.code
	}
}

/**
 * Injection seam for host error policy. Hosts with their own error taxonomy
 * (e.g. an App.errors singleton) adapt it to this shape; everyone else uses
 * the default factory below.
 */
export type ErrorFactory = {
	throw(input: { code: string; message?: string }): never
}

export const defaultErrors: ErrorFactory = {
	throw(input) {
		throw new KitError(input)
	},
}
