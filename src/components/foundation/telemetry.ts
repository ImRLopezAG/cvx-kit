import { z } from 'zod'

type SemanticValue = string | number | boolean

const semanticToken = /^[A-Za-z][A-Za-z0-9_.-]{0,159}$/
const semanticValue = z.union([z.string().regex(semanticToken), z.number().finite(), z.boolean()])

/** Emit bounded semantic fields only; free-form payloads and identifiers drop. */
export function emitSemanticEvent(
	event: string,
	fields: Readonly<Record<string, SemanticValue | undefined>> = {},
): void {
	try {
		if (!semanticToken.test(event)) return
		const safe = Object.fromEntries(
			Object.entries(fields).filter(
				([key, value]) => semanticToken.test(key) && semanticValue.safeParse(value).success,
			),
		)
		console.info(JSON.stringify({ event, ...safe }))
	} catch {
		// Telemetry must never change command behavior.
	}
}
