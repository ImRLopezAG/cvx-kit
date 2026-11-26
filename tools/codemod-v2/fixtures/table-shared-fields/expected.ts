import { kTable, k } from 'cvx-kit'

const lineFields = {
	sku: k.string(),
	quantity: k.int().min(0),
}

export const lines = kTable('lines', lineFields)

export const archivedLines = kTable('archivedLines', lineFields, { publicFields: ['sku'] })
