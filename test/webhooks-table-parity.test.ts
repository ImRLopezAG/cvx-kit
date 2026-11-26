// The v2 webhook dedup table stores exactly what v1's zodTable version stored. The snapshot was
// captured from v1 (`webhookEventsTable()` on zodTable, storage and insert sides through the kit's
// zodToConvex) before the conversion; it is not regenerated from v2.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vite-plus/test'

import { webhookEventsTable } from '../src/webhooks'
import { exportTable, validatorJson } from './parity/helpers'

const v1 = JSON.parse(
	readFileSync(new URL('./webhooks-table-parity.snapshot.json', import.meta.url), 'utf8'),
)

describe('webhookEventsTable parity with v1', () => {
	it('exports the same table, with and without the by_eventKey index', () => {
		const boundary = webhookEventsTable()
		expect(boundary.tableName).toBe(v1.tableName)
		expect(exportTable(boundary.table)).toEqual(v1.table)
		expect(exportTable(webhookEventsTable().table.index('by_eventKey', ['eventKey']))).toEqual(
			v1.indexed,
		)
	})

	it('stores and inserts the same native shapes', () => {
		const boundary = webhookEventsTable()
		expect(validatorJson(boundary.storage.validator)).toEqual(v1.storage)
		expect(validatorJson(boundary.insertSchema.validator)).toEqual(v1.insertSchema)
		expect(validatorJson(boundary.storage.outputValidator)).toEqual(
			validatorJson(boundary.storage.validator),
		)
	})
})
