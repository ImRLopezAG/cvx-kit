import { k } from 'cvx-kit'

export const User = k.strictObject({ name: k.string() })

export type User = k.infer<typeof User>
export type UserInput = k.input<typeof User>
export type UserOutput = k.output<typeof User>

export function greet(user: k.infer<typeof User>): string {
	return user.name
}
