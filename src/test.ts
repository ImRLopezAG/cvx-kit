/**
 * Test helpers for consumers, following the official component template:
 * register the kit's components on a convex-test instance so host-app tests
 * run against them in-memory. Requires a vitest-compatible runner
 * (import.meta.glob), which is why this export ships as source.
 */
import approvalsSchema from './components/approvals/schema'
import foundationSchema from './components/foundation/schema'

const foundationModules = import.meta.glob(
	'./components/foundation/**/!(*.test).ts',
)
const approvalsModules = import.meta.glob(
	'./components/approvals/**/!(*.test).ts',
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
