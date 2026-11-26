import { kTable, k } from 'cvx-kit'

const lineFields = {
	sku: k.string(),
	quantity: k.int().safe().nonnegative(),
}

export const lines = kTable('lines', lineFields)

export const archivedLines = kTable('archivedLines', lineFields, { publicFields: ['sku'] })
