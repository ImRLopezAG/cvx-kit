/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as audit from "../audit.js";
import type * as client from "../client.js";
import type * as constants from "../constants.js";
import type * as decisions from "../decisions.js";
import type * as functions from "../functions.js";
import type * as requests from "../requests.js";
import type * as validators from "../validators.js";
import type * as workflow from "../workflow.js";
import type * as workflow_steps from "../workflow_steps.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  audit: typeof audit;
  client: typeof client;
  constants: typeof constants;
  decisions: typeof decisions;
  functions: typeof functions;
  requests: typeof requests;
  validators: typeof validators;
  workflow: typeof workflow;
  workflow_steps: typeof workflow_steps;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
  auditLog: import("convex-audit-log/_generated/component.js").ComponentApi<"auditLog">;
};
