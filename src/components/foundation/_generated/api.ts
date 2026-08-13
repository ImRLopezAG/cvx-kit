/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as client from "../client.js";
import type * as functions from "../functions.js";
import type * as modules_command_command from "../modules/command/command.js";
import type * as modules_observability_observability from "../modules/observability/observability.js";
import type * as modules_query_query from "../modules/query/query.js";
import type * as result from "../result.js";
import type * as telemetry from "../telemetry.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  client: typeof client;
  functions: typeof functions;
  "modules/command/command": typeof modules_command_command;
  "modules/observability/observability": typeof modules_observability_observability;
  "modules/query/query": typeof modules_query_query;
  result: typeof result;
  telemetry: typeof telemetry;
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

export const components = componentsGeneric() as unknown as {};
