export {
	defaultErrors,
	KitError,
	type ErrorFactory,
} from './errors'
export {
	createModule,
	jsonSafeZid,
	paginated,
	tenantTable,
	TIMESTAMP_FIELDS,
	zodTable,
	zodVariantTable,
	type TableBoundaryOptions,
} from './zod-table'
export {
	assertTenantOwned,
	composeRules,
	createTenantRules,
	requireTenantReference,
	TENANT_FIELD,
	type RLSConfig,
	type Rules,
} from './tenancy'
export {
	createAuthFunctions,
	createInclude,
	defaultRoleMap,
	type Actor,
	type AuthBundle,
	type AuthFunctionsConfig,
	type DefaultRole,
	type Include,
	type IncludedQuery,
	type SecurityConfig,
} from './auth'
export {
	createAgentTools,
	type AgentToolHandlers,
	type AgentToolRecord,
} from './agent-tools'
export { createCrudCommands, type CrudConfig } from './crud'
export { rateLimit, type RateLimiterLike } from './middleware'
export {
	createWebhookBoundary,
	recordWebhookEvent,
	webhookEventsTable,
	type WebhookBoundaryConfig,
} from './webhooks'
export { createStateMachine } from './state-machine'
export {
	appendOnly,
	tenantOwnership,
	createTriggers,
	noDelete,
	timestamps,
	Triggers,
	type Change,
	type Trigger,
} from './triggers'
export {
	Foundation,
	type ApplicationCommand,
	type AuditedOperation,
	type AuditedRegistry,
	type AuditEntryInput,
	type AuditWriter,
	type CommandConstructor,
	type CommandDefaults,
	type AnyCommandMiddleware,
	type AnyQueryMiddleware,
	type CommandMiddleware,
	type FoundationOptions,
	type PermissionChecker,
	type QueryMiddleware,
} from './components/foundation/client'
