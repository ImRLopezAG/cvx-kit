/** Browser-safe scalar contracts. Import this declaration from both browser and stored-table modules. */
export {
	defineFilterContract,
	type FilterContract,
	type FilterDescriptor,
	type SharedFilters,
	type SharedField,
} from './querying/shared/contract'
export { evaluateFilter } from './querying/shared/evaluate'
export type { FilterAst, FilterOperator, FilterScalar } from './querying/shared/ast'
