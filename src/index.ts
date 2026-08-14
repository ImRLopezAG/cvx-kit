export {
	defaultErrors,
	KitError,
	type ErrorFactory,
} from './errors'
export {
	createModule,
	jsonSafeZid,
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
	type CommandDefaults,
	type FoundationOptions,
	type PermissionChecker,
} from './components/foundation/client'
