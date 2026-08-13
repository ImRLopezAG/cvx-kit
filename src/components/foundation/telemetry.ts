type SemanticValue = string | number | boolean

const semanticToken = /^[A-Za-z][A-Za-z0-9_.-]{0,159}$/

/** Emit bounded semantic fields only; free-form payloads and identifiers drop. */
export function emitSemanticEvent(
	event: string,
	fields: Readonly<Record<string, SemanticValue | undefined>> = {},
): void {
	try {
		if (!semanticToken.test(event)) return
		const safe: Record<string, SemanticValue> = { event }
		for (const [key, value] of Object.entries(fields)) {
			if (!semanticToken.test(key) || value === undefined) continue
			if (typeof value === 'string' && !semanticToken.test(value)) continue
			if (typeof value === 'number' && !Number.isFinite(value)) continue
			safe[key] = value
		}
		console.info(JSON.stringify(safe))
	} catch {
		// Telemetry must never change command behavior.
	}
}
