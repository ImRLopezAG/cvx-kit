import { Context, Effect } from 'effect'

/** The request an operation joined: its outermost operation, its direct caller, and its nesting depth. */
export type RequestScope = Readonly<{ root: string; parent: string; depth: number }>

/** How nested operations audit when an enclosing operation already declares an audit callback. */
export type NestedAuditMode = 'fold' | 'separate'

/** Request-wide state shared by every operation yielded inside the same Effect program. */
export type ScopeState = Readonly<{
	scope: RequestScope
	/** Whether some enclosing operation declares an audit callback. */
	audited: boolean
	/** Failure values already reported to the failure-audit sink in this request. */
	reported: WeakSet<object>
}>

const CurrentScope = Context.Reference<ScopeState | undefined>('cvx-kit/effect/RequestScope', {
	defaultValue: () => undefined,
})

/**
 * Run an operation inside the current request scope, opening one when none exists.
 * `run` receives the state the operation entered (`undefined` for a root) and the
 * state it provides to the operations yielded inside it.
 */
export function enterRequestScope<Value, Error, Requirements>(
	operation: string,
	audits: boolean,
	run: (
		entered: ScopeState | undefined,
		current: ScopeState,
	) => Effect.Effect<Value, Error, Requirements>,
): Effect.Effect<Value, Error, Requirements> {
	return CurrentScope.use((entered) => {
		const current: ScopeState = {
			scope: {
				root: entered?.scope.root ?? operation,
				parent: operation,
				depth: (entered?.scope.depth ?? 0) + 1,
			},
			audited: audits || (entered?.audited ?? false),
			reported: entered?.reported ?? new WeakSet(),
		}
		return run(entered, current).pipe(Effect.provideService(CurrentScope, current))
	})
}

export function auditFolded(mode: NestedAuditMode | undefined, entered: ScopeState | undefined) {
	return (mode ?? 'fold') === 'fold' && entered?.audited === true
}
