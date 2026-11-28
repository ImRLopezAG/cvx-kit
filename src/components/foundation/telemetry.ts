type SemanticValue = string | number | boolean

const semanticToken = /^[A-Za-z][A-Za-z0-9_.-]{0,159}$/

/** Emit bounded semantic fields only; free-form payloads and identifiers drop. */
export function emitSemanticEvent(
	event: string,
	fields: Readonly<Record<string, SemanticValue | undefined>> = {},
): void {
	try {
		if (!semanticToken.test(event)) return
		const safe = Object.fromEntries(
			Object.entries(fields).filter(
				([key, value]) => semanticToken.test(key) && isSemanticValue(value),
			),
		)
		console.info(JSON.stringify({ event, ...safe }))
	} catch {
		// Telemetry must never change command behavior.
	}
}

/** A token-shaped string, a finite number or a boolean; everything else drops. */
function isSemanticValue(value: SemanticValue | undefined): boolean {
	return (
		value === true ||
		value === false ||
		Number.isFinite(value) ||
		(String(value) === value && semanticToken.test(value))
	)
}
