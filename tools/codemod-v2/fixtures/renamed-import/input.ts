import { z as zod } from 'zod/v4'

export const Named = zod.strictObject({ a: zod.string() })
export type Named = zod.infer<typeof Named>

export function local(z: { object: (value: number) => number }) {
	return z.object(1)
}
