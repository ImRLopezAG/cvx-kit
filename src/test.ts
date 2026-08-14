/**
 * Test helpers for consumers, following the official component template:
 * register the kit's components on a convex-test instance so host-app tests
 * run against them in-memory. Requires a vitest-compatible runner
 * (import.meta.glob), which is why this file ships as source — but it
 * registers the COMPILED component modules from dist, so dist is the only
 * code the package ships.
 */
import approvalsSchema from '../dist/components/approvals/schema.mjs'
import foundationSchema from '../dist/components/foundation/schema.mjs'

const foundationModules = import.meta.glob(
	'../dist/components/foundation/**/*.mjs',
)
const approvalsModules = import.meta.glob(
	'../dist/components/approvals/**/*.mjs',
)

type RegistersComponents = {
	registerComponent: (
		name: string,
		schema: unknown,
		modules: Record<string, () => Promise<unknown>>,
	) => void
}

/** Registers the foundation component under its default install name. */
export function registerFoundation(
	t: RegistersComponents,
	name = 'foundation',
) {
	t.registerComponent(name, foundationSchema, foundationModules)
}

/** Registers the approvals component under its default install name. */
export function registerApprovals(t: RegistersComponents, name = 'approvals') {
	t.registerComponent(name, approvalsSchema, approvalsModules)
}
