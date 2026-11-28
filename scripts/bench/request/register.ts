// Shared registration for the v1 and v2 request entries: the five operations
// of one domain, registered through the auth builders exactly the same way on
// both sides. Only the schemas the fixture hands in differ.

/** One operation: which builder registers it and thunks for its declarations. */
export type Operation = {
	readonly kind: 'mutation' | 'query'
	readonly args: () => object
	readonly returns: () => object
}

/** What the entries hand to a builder: declared or accessor `args`/`returns`, and the handler. */
export type FunctionDefinition = {
	readonly args: object
	readonly returns: object
	readonly handler: () => Promise<OperationResult>
}

/** The `authMutation` / `authQuery` constructors both auth factories return. */
export type AuthBuilders = {
	readonly authMutation: (definition: FunctionDefinition) => object
	readonly authQuery: (definition: FunctionDefinition) => object
}

/** A registered Convex function with the hooks the Convex runtime calls. */
export type RegisteredFunction = {
	exportArgs(): string
	exportReturns(): string
	invokeMutation?(args: string): Promise<string>
	invokeQuery?(args: string): Promise<string>
}

/** A valid public row with `_id`: what `create` returns, so v1's return parse succeeds. */
const created = {
	_id: 'k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r',
	ref: 'R-1',
	status: 'open',
	title: 'Quarterly report',
	amountCents: 1250,
	active: true,
	tags: ['finance'],
	details: { text: 'Prepared for review' },
}

const results = { create: created, update: null, get: null, list: [], archive: null }
const names = ['create', 'update', 'get', 'list', 'archive'] as const

/** What one operation's handler resolves to. */
type OperationResult = (typeof results)[keyof typeof results]

/**
 * Registers every operation. With `getters`, `args` and `returns` are
 * declared as accessors, so nothing is built until Convex or a call reads them.
 */
export function registerOperations(
	auth: AuthBuilders,
	operations: Readonly<Record<keyof typeof results, Operation>>,
	getters: boolean,
) {
	// oxlint-disable-next-line anti-slop/no-known-value-widening -- Keys are the fixed operation names; values are filled in the loop.
	const functions: Partial<Record<keyof typeof results, RegisteredFunction>> = {}
	for (const name of names) {
		const operation = operations[name]
		const result = results[name]
		const handler = async () => result
		const builder = operation.kind === 'mutation' ? auth.authMutation : auth.authQuery
		const registered = builder(
			getters
				? {
						get args() {
							return operation.args()
						},
						get returns() {
							return operation.returns()
						},
						handler,
					}
				: { args: operation.args(), returns: operation.returns(), handler },
		)
		// SAFETY: Convex builders return functions carrying these runtime hooks; public typings omit them.
		functions[name] = registered as RegisteredFunction
	}
	return functions
}
