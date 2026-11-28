// Characterises the native validators the kit's two Convex components deploy: every table's exported
// definition and every registered function's exported args and returns. Written before the components
// moved from Zod to `k` (U17); the port must keep this snapshot unchanged.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, test } from 'vite-plus/test'

import { approvalCallbackArgs } from '../src/components/approvals/client'
import * as approvalsAudit from '../src/components/approvals/audit'
import * as approvalsDecisions from '../src/components/approvals/decisions'
import * as approvalsHealth from '../src/components/approvals/health'
import * as approvalsRequests from '../src/components/approvals/requests'
import approvalsSchema from '../src/components/approvals/schema'
import * as approvalsWorkflow from '../src/components/approvals/workflow'
import * as foundationFunctions from '../src/components/foundation/functions'
import foundationSchema from '../src/components/foundation/schema'
import { exportTable, toSnapshot, validatorJson, type Snapshot } from './parity/helpers'

const SNAPSHOT_FILE = new URL('./components-validator-parity.snapshot.json', import.meta.url)

type Registered = Readonly<{ exportArgs: () => string; exportReturns: () => string }>

const modules = {
	'approvals/audit': approvalsAudit,
	'approvals/decisions': approvalsDecisions,
	'approvals/health': approvalsHealth,
	'approvals/requests': approvalsRequests,
	'approvals/workflow': approvalsWorkflow,
	'foundation/functions': foundationFunctions,
}

function isRegistered<Value>(value: Value): value is Value & Registered {
	return (
		value instanceof Function &&
		'exportArgs' in value &&
		value.exportArgs instanceof Function &&
		'exportReturns' in value &&
		value.exportReturns instanceof Function
	)
}

function functionsSnapshot(): Snapshot {
	const out: Record<string, Snapshot> = {}
	for (const [path, module] of Object.entries(modules))
		for (const [name, value] of Object.entries(module))
			if (isRegistered(value))
				out[`${path}:${name}`] = toSnapshot({
					args: JSON.parse(value.exportArgs()),
					returns: JSON.parse(value.exportReturns()),
				})
	return out
}

function tablesSnapshot(): Snapshot {
	const out: Record<string, Snapshot> = {}
	for (const [component, schema] of Object.entries({
		approvals: approvalsSchema,
		foundation: foundationSchema,
	}))
		for (const [name, table] of Object.entries(schema.tables))
			out[`${component}/${name}`] = exportTable(table)
	return out
}

describe('component validator parity', () => {
	test('tables, function args/returns and approvalCallbackArgs match the committed snapshot', () => {
		const actual = `${JSON.stringify(
			toSnapshot({
				tables: tablesSnapshot(),
				functions: functionsSnapshot(),
				approvalCallbackArgs: validatorJson(approvalCallbackArgs),
			}),
			null,
			'\t',
		)}\n`
		// `_updateSnapshot` is vitest's private mode flag; it is 'all' under `-u`.
		if (!existsSync(SNAPSHOT_FILE) || expect.getState().snapshotState['_updateSnapshot'] === 'all')
			writeFileSync(SNAPSHOT_FILE, actual)
		expect(JSON.parse(actual)).toEqual(JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8')))
	})
})
