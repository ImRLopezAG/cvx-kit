/** cvx-kit 2 validators: chainable schemas over native Convex validators. */
export { k } from './k/index'
export {
	KValidationError,
	type KIssue,
	type KIssueCode,
	type KIssueInput,
	type KSafeParseResult,
	type KValidationData,
} from './k/issues'
export type {
	KAny,
	KArray,
	KBoolean,
	KBytes,
	KDiscriminatedUnion,
	KEnum,
	KId,
	KInt64,
	KJson,
	KLiteral,
	KNull,
	KNumber,
	KRecord,
	KRecordKey,
	KString,
	KUnion,
} from './k/kinds'
export type { KIsoDate, KIsoDateTime, KTimestamp } from './k/dates'
export type { KObject } from './k/object'
export type {
	KCheckContext,
	KDefault,
	KNarrowed,
	KNullable,
	KOptional,
	KPipe,
	KSchema,
	KTransform,
} from './k/schema'
export type { KFields, KPath, KRefineOptions, KType, NativeOf, OutputNativeOf } from './k/types'
