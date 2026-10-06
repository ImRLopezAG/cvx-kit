import type { FunctionReference } from 'convex/server'
import { api, internal } from './convex/_generated/api'

const publicQuery: FunctionReference<
	'query',
	'public',
	{ key: string },
	{ count: number; events: string[] }
> = api.functions.composed
const publicMutation: FunctionReference<
	'mutation',
	'public',
	{ key: string; mode: 'success' | 'domain' | 'audit' | 'completion' },
	'saved'
> = api.functions.save
const internalMutation: FunctionReference<
	'mutation',
	'internal',
	{ key: string; mode: 'success' | 'domain' | 'audit' | 'completion' },
	'saved'
> = internal.functions.internalSave
const publicAction: FunctionReference<
	'action',
	'public',
	{ key: string },
	{ body: string; stages: string[]; rejected: boolean }
> = api.actions.orchestrate
// @ts-expect-error The real generated public API excludes internal registrations.
void api.functions.internalSave
// @ts-expect-error Query references retain native function kind.
const wrongKind: FunctionReference<
	'mutation',
	'public',
	{ key: string },
	{ count: number; events: string[] }
> = api.functions.composed
// @ts-expect-error Generated args reject incorrectly typed keys.
const wrongArgs: FunctionReference<
	'query',
	'public',
	{ key: number },
	{ count: number; events: string[] }
> = api.functions.composed
void [publicQuery, publicMutation, internalMutation, publicAction, wrongKind, wrongArgs]
