import type { KCheckMessage, KMessage, KRefineOptions } from './types'

/**
 * The message of a check's options: `message`, or Zod 4's `error` string when `message` is absent.
 * A function-valued `error` (Zod's error map) is not supported and throws at declaration.
 */
export function checkMessage(message: KCheckMessage | undefined, method: string): string | undefined {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- a check takes either its message or an options object.
	if (message === undefined || typeof message === 'string') return message
	return optionsMessage(message, method)
}

/** Refine options normalised and frozen in place: `error` folded into `message`, `path` frozen. */
export function refineMessage(message: string | KRefineOptions | undefined): KMessage {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- refine takes either its message or an options object.
	if (message === undefined || typeof message === 'string') return message
	const text = optionsMessage(message, 'refine')
	if (message.path !== undefined) Object.freeze(message.path)
	if (text === message.message && !('error' in message)) return Object.freeze(message)
	return Object.freeze({ message: text, path: message.path })
}

function optionsMessage(options: KCheckMessage & object, method: string): string | undefined {
	const error: unknown = 'error' in options ? options.error : undefined
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Zod's error map is a function; k accepts only a string.
	if (error !== undefined && typeof error !== 'string')
		throw new Error(
			`k: .${method}() options: 'error' must be a string; a Zod error map function is not supported, pass { message: '…' }`,
		)
	return options.message ?? error
}
