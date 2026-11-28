import { z } from 'zod'
import { k } from 'cvx-kit'

const Leaf = z.lazy(() => z.string())

const Middle = z.strictObject({ leaf: Leaf })

const Top = z.strictObject({ middle: Middle.optional() })

export type Top = z.infer<typeof Top>

export const Independent = k.strictObject({ id: k.string() })

export function check(value: string) {
	return Top.parse(value)
}
