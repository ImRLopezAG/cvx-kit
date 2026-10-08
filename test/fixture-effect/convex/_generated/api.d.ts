/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actionValidation from "../actionValidation.js";
import type * as actions from "../actions.js";
import type * as asyncDomain from "../asyncDomain.js";
import type * as crud from "../crud.js";
import type * as domain from "../domain.js";
import type * as functions from "../functions.js";
import type * as http from "../http.js";
import type * as idempotency from "../idempotency.js";
import type * as idempotencyDeploymentConfig from "../idempotencyDeploymentConfig.js";
import type * as integratedRename from "../integratedRename.js";
import type * as operationTools from "../operationTools.js";
import type * as workflowNative from "../workflowNative.js";
import type * as workflowProof from "../workflowProof.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  actionValidation: typeof actionValidation;
  actions: typeof actions;
  asyncDomain: typeof asyncDomain;
  crud: typeof crud;
  domain: typeof domain;
  functions: typeof functions;
  http: typeof http;
  idempotency: typeof idempotency;
  idempotencyDeploymentConfig: typeof idempotencyDeploymentConfig;
  integratedRename: typeof integratedRename;
  operationTools: typeof operationTools;
  workflowNative: typeof workflowNative;
  workflowProof: typeof workflowProof;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
