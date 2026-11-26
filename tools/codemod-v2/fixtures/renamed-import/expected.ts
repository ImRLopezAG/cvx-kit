import { k } from 'cvx-kit'

export const Named = k.object({ a: k.string() })
export type Named = k.infer<typeof Named>

export function local(z: { object: (value: number) => number }) {
	return z.object(1)
}
