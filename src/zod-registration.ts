// Internal auth registration seam. Public wrapper contracts match convex-helpers zod4.
// Keep the installed helper's registration branches; only argument conversion differs.
import { pick } from 'convex-helpers'
import { NoOp, type Customization } from 'convex-helpers/server/customFunctions'
import { zodOutputToConvex, type CustomBuilder } from 'convex-helpers/server/zod4'
import { addFieldsToValidator } from 'convex-helpers/validators'
import type {
	ActionBuilder,
	FunctionVisibility,
	GenericActionCtx,
	GenericDataModel,
	GenericMutationCtx,
	GenericQueryCtx,
	MutationBuilder,
	QueryBuilder,
} from 'convex/server'
import { ConvexError, type PropertyValidators, type Value } from 'convex/values'
import * as z from 'zod/v4'
import * as zCore from 'zod/v4/core'
import { zodToConvex } from './zod-convex'

export function zCustomQuery<
	CustomArgsValidator extends PropertyValidators,
	CustomCtx extends Record<string, any>,
	CustomMadeArgs extends Record<string, any>,
	Visibility extends FunctionVisibility,
	DataModel extends GenericDataModel,
	ExtraArgs extends Record<string, any> = object,
>(
	query: QueryBuilder<DataModel, Visibility>,
	customization: Customization<
		GenericQueryCtx<DataModel>,
		CustomArgsValidator,
		CustomCtx,
		CustomMadeArgs,
		ExtraArgs
	>,
) {
	// SAFETY: the private adapter preserves helper registration semantics; this is
	// the same generic boundary assertion used by the public helper wrappers.
	return customFnBuilder(query, customization) as CustomBuilder<
		'query',
		CustomArgsValidator,
		CustomCtx,
		CustomMadeArgs,
		GenericQueryCtx<DataModel>,
		Visibility,
		ExtraArgs
	>
}

export function zCustomMutation<
	CustomArgsValidator extends PropertyValidators,
	CustomCtx extends Record<string, any>,
	CustomMadeArgs extends Record<string, any>,
	Visibility extends FunctionVisibility,
	DataModel extends GenericDataModel,
	ExtraArgs extends Record<string, any> = object,
>(
	mutation: MutationBuilder<DataModel, Visibility>,
	customization: Customization<
		GenericMutationCtx<DataModel>,
		CustomArgsValidator,
		CustomCtx,
		CustomMadeArgs,
		ExtraArgs
	>,
) {
	// SAFETY: the private adapter preserves helper registration semantics; this is
	// the same generic boundary assertion used by the public helper wrappers.
	return customFnBuilder(mutation, customization) as CustomBuilder<
		'mutation',
		CustomArgsValidator,
		CustomCtx,
		CustomMadeArgs,
		GenericMutationCtx<DataModel>,
		Visibility,
		ExtraArgs
	>
}

export function zCustomAction<
	CustomArgsValidator extends PropertyValidators,
	CustomCtx extends Record<string, any>,
	CustomMadeArgs extends Record<string, any>,
	Visibility extends FunctionVisibility,
	DataModel extends GenericDataModel,
	ExtraArgs extends Record<string, any> = object,
>(
	action: ActionBuilder<DataModel, Visibility>,
	customization: Customization<
		GenericActionCtx<DataModel>,
		CustomArgsValidator,
		CustomCtx,
		CustomMadeArgs,
		ExtraArgs
	>,
) {
	// SAFETY: the private adapter preserves helper registration semantics; this is
	// the same generic boundary assertion used by the public helper wrappers.
	return customFnBuilder(action, customization) as CustomBuilder<
		'action',
		CustomArgsValidator,
		CustomCtx,
		CustomMadeArgs,
		GenericActionCtx<DataModel>,
		Visibility,
		ExtraArgs
	>
}

function customFnBuilder(
	builder: (args: any) => any,
	customization: Customization<any, any, any, any, any>,
) {
	// Looking forward to when input / args / ... are optional
	const customInput: Customization<any, any, any, any, any>['input'] =
		customization.input ?? NoOp.input
	const inputArgs = customization.args ?? NoOp.args
	return function customBuilder(fn: any): any {
		const { args, handler = fn, skipConvexValidation = false, returns: maybeObject, ...extra } = fn

		const returns =
			maybeObject && !(maybeObject instanceof zCore.$ZodType) ? z.object(maybeObject) : maybeObject

		const returnValidator =
			returns && !skipConvexValidation ? { returns: zodOutputToConvex(returns) } : null

		if (args) {
			let argsValidator = args
			if (argsValidator instanceof zCore.$ZodType) {
				if (argsValidator instanceof zCore.$ZodObject) {
					argsValidator = argsValidator._zod.def.shape
				} else {
					throw new Error(
						'Unsupported zod type as args validator: ' + argsValidator.constructor.name,
					)
				}
			}
			// One conversion preserves graph sharing across all user argument fields.
			const convexValidator = zodToConvex(z.object(argsValidator))
			return builder({
				args: skipConvexValidation ? undefined : addFieldsToValidator(convexValidator, inputArgs),
				...returnValidator,
				handler: async (ctx: any, allArgs: any) => {
					const added = await customInput(ctx, pick(allArgs, Object.keys(inputArgs)), extra)
					const rawArgs = pick(allArgs, Object.keys(argsValidator))
					const parsed = await z.object(argsValidator).safeParseAsync(rawArgs)
					if (!parsed.success) {
						throw new ConvexError({
							// SAFETY: serialized Zod issues are the helper's existing Convex Value[] error payload.
							ZodError: JSON.parse(JSON.stringify(parsed.error.issues, null, 2)) as Value[],
						})
					}
					const args = parsed.data
					const finalCtx = { ...ctx, ...added.ctx }
					const finalArgs = { ...args, ...added.args }
					const ret = await handler(finalCtx, finalArgs)
					// We don't catch the error here. It's a developer error and we
					// don't want to risk exposing the unexpected value to the client.
					const result = returns ? await returns.parseAsync(ret === undefined ? null : ret) : ret
					if (added.onSuccess) {
						await added.onSuccess({ ctx, args, result })
					}
					return result
				},
			})
		}
		if (skipConvexValidation && Object.keys(inputArgs).length > 0) {
			throw new Error(
				"If you're using a custom function with arguments for the input " +
					'customization, you cannot skip convex validation.',
			)
		}
		return builder({
			...returnValidator,
			handler: async (ctx: any, args: any) => {
				const added = await customInput(ctx, args, extra)
				const finalCtx = { ...ctx, ...added.ctx }
				const finalArgs = { ...args, ...added.args }
				const ret = await handler(finalCtx, finalArgs)
				// We don't catch the error here. It's a developer error and we
				// don't want to risk exposing the unexpected value to the client.
				const result = returns ? await returns.parseAsync(ret === undefined ? null : ret) : ret
				if (added.onSuccess) {
					await added.onSuccess({ ctx, args, result })
				}
				return result
			},
		})
	}
}
