import { z } from 'zod'

export const Item = z.strictObject({ id: z.string() })

export function read(value: string) {
	const result = Item.safeParse(value)
	if (!result.success) return result.error.issues
	return result.data
}

export function readOk(value: string) {
	const result = Item.safeParse(value)
	return result.success ? result.data : null
}
