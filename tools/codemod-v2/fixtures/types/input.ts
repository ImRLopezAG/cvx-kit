import { z } from 'zod'

export const User = z.strictObject({ name: z.string() })

export type User = z.infer<typeof User>
export type UserInput = z.input<typeof User>
export type UserOutput = z.output<typeof User>

export function greet(user: z.infer<typeof User>): string {
	return user.name
}
