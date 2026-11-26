import { z } from 'zod'
import { zodTable } from 'cvx-kit'

const lineFields = {
	sku: z.string(),
	quantity: z.int().nonnegative(),
}

export const lines = zodTable('lines', () => lineFields)

export const archivedLines = zodTable('archivedLines', () => lineFields, { publicFields: ['sku'] })
