/**
 * Test helpers for consumers, following the official component template:
 * register the kit's components on a convex-test instance so host-app tests
 * run against them in-memory. Requires a vitest-compatible runner
 * (import.meta.glob), which is why this file ships as source — but it
 * registers the COMPILED component modules from dist, so dist is the only
 * code the package ships.
 */
import type { GenericId } from 'convex/values'
import type { TestConvex } from 'convex-test'
import type { GenericSchema, SchemaDefinition } from 'convex/server'
import approvalsSchema from '../dist/components/approvals/schema.js'
import foundationSchema from '../dist/components/foundation/schema.js'

const foundationModules = import.meta.glob('../dist/components/foundation/**/*.mjs')
const approvalsModules = import.meta.glob('../dist/components/approvals/**/*.mjs')

type RegistersComponents = Pick<
	TestConvex<SchemaDefinition<GenericSchema, boolean>>,
	'registerComponent'
>

/** Registers the foundation component under its default install name. */
export function registerFoundation(t: RegistersComponents, name = 'foundation') {
	t.registerComponent(name, foundationSchema, foundationModules)
}

/** Registers the approvals component under its default install name. */
export function registerApprovals(t: RegistersComponents, name = 'approvals') {
	t.registerComponent(name, approvalsSchema, approvalsModules)
}

/** Brands a test fixture string. It does not validate a real Convex id. */
export function asId<T extends string>(_table: T, value: string): GenericId<T> {
	// SAFETY: fixture branding is deliberate; storage references require actual inserted ids.
	return value as GenericId<T>
}
