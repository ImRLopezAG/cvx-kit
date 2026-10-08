import type { GenericDatabaseReader, GenericDataModel } from 'convex/server'
import type { Infer, Validator } from 'convex/values'
import { toStandardSchema } from 'convex-helpers/standardSchema'
import { standardContract } from './standard'

/** Keep native registration authoritative, especially for actions with no db. */
export function convexContract<const V extends Validator<unknown, 'required' | 'optional', string>>(
	validator: V,
	options?: { db?: GenericDatabaseReader<GenericDataModel> },
) {
	return { ...standardContract(toStandardSchema(validator, options)), nativeValidator: validator }
}
export type ConvexContractValue<V extends Validator<unknown, 'required' | 'optional', string>> =
	Infer<V>
