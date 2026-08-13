/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    audit: {
      cleanup: FunctionReference<
        "mutation",
        "internal",
        { batchSize: number; olderThanDays: number },
        number,
        Name
      >;
      history: FunctionReference<
        "query",
        "internal",
        { limit?: number; resourceRef: string; resourceType: string },
        Array<{
          action: string;
          actorRef?: string;
          correlationKey: string;
          transition: string;
        }>,
        Name
      >;
    };
    decisions: {
      decide: FunctionReference<
        "mutation",
        "internal",
        {
          actor: {
            actorRef: string;
            capabilities: Array<string>;
            metadata?: Record<string, string>;
          };
          compatibilityKey: string;
          decision: "approved" | "rejected";
          reason?: string;
          runId: string;
        },
        { state: "pending" | "approved" | "rejected" | "expired" | "canceled" },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { runId: string },
        Array<{
          actorRef: string;
          decidedAt: number;
          decision: "approved" | "rejected";
          reason?: string;
          stepKey: string;
        }>,
        Name
      >;
    };
    requests: {
      cancel: FunctionReference<
        "mutation",
        "internal",
        {
          actor: {
            actorRef: string;
            capabilities: Array<string>;
            metadata?: Record<string, string>;
          };
          compatibilityKey: string;
          runId: string;
        },
        { state: "canceled" },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          scopeRef: string;
          state?: "pending" | "approved" | "rejected" | "expired" | "canceled";
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: string;
            createdAt: number;
            currentStepKey?: string;
            executionFailedStepKey?: string;
            expiresAt?: number;
            metadata?: Record<string, string>;
            requester: {
              actorRef: string;
              capabilities: Array<string>;
              metadata?: Record<string, string>;
            };
            resourceRef: string;
            resourceType: string;
            scopeRef: string;
            state: "pending" | "approved" | "rejected" | "expired" | "canceled";
            terminalAt?: number;
            updatedAt: number;
            workflow: {
              compatibilityKey: string;
              name: string;
              schemaVersion: 1;
              steps: Array<
                | {
                    callback: {
                      handle: string;
                      kind: "mutation";
                      retry: boolean;
                    };
                    key: string;
                    kind: "mutation";
                  }
                | {
                    callback: {
                      handle: string;
                      kind: "action";
                      retry: boolean;
                    };
                    key: string;
                    kind: "action";
                  }
                | {
                    callback: {
                      handle: string;
                      kind: "action";
                      retry: boolean;
                    };
                    key: string;
                    kind: "notify";
                  }
                | {
                    decisions: Array<"approved" | "rejected">;
                    expiresAfterMs?: number;
                    key: string;
                    kind: "decision";
                    makerChecker: boolean;
                    quorum: { approvals: number; kind: "count" };
                  }
                | {
                    approvedStepKey: string;
                    key: string;
                    kind: "branch";
                    rejectedStepKey: string;
                  }
              >;
            };
            workflowId?: string;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
      restart: FunctionReference<
        "mutation",
        "internal",
        { compatibilityKey: string; runId: string },
        null,
        Name
      >;
      start: FunctionReference<
        "mutation",
        "internal",
        {
          metadata?: Record<string, string>;
          requester: {
            actorRef: string;
            capabilities: Array<string>;
            metadata?: Record<string, string>;
          };
          resourceRef: string;
          resourceType: string;
          scopeRef: string;
          workflow: {
            compatibilityKey: string;
            name: string;
            schemaVersion: 1;
            steps: Array<
              | {
                  callback: {
                    handle: string;
                    kind: "mutation";
                    retry: boolean;
                  };
                  key: string;
                  kind: "mutation";
                }
              | {
                  callback: { handle: string; kind: "action"; retry: boolean };
                  key: string;
                  kind: "action";
                }
              | {
                  callback: { handle: string; kind: "action"; retry: boolean };
                  key: string;
                  kind: "notify";
                }
              | {
                  decisions: Array<"approved" | "rejected">;
                  expiresAfterMs?: number;
                  key: string;
                  kind: "decision";
                  makerChecker: boolean;
                  quorum: { approvals: number; kind: "count" };
                }
              | {
                  approvedStepKey: string;
                  key: string;
                  kind: "branch";
                  rejectedStepKey: string;
                }
            >;
          };
        },
        { runId: string },
        Name
      >;
      status: FunctionReference<
        "query",
        "internal",
        { compatibilityKey: string; runId: string },
        null | {
          execution:
            | null
            | { type: "inProgress" }
            | { type: "completed" }
            | { type: "canceled" }
            | { error: string; type: "failed" };
          run: {
            _creationTime: number;
            _id: string;
            createdAt: number;
            currentStepKey?: string;
            executionFailedStepKey?: string;
            expiresAt?: number;
            metadata?: Record<string, string>;
            requester: {
              actorRef: string;
              capabilities: Array<string>;
              metadata?: Record<string, string>;
            };
            resourceRef: string;
            resourceType: string;
            scopeRef: string;
            state: "pending" | "approved" | "rejected" | "expired" | "canceled";
            terminalAt?: number;
            updatedAt: number;
            workflow: {
              compatibilityKey: string;
              name: string;
              schemaVersion: 1;
              steps: Array<
                | {
                    callback: {
                      handle: string;
                      kind: "mutation";
                      retry: boolean;
                    };
                    key: string;
                    kind: "mutation";
                  }
                | {
                    callback: {
                      handle: string;
                      kind: "action";
                      retry: boolean;
                    };
                    key: string;
                    kind: "action";
                  }
                | {
                    callback: {
                      handle: string;
                      kind: "action";
                      retry: boolean;
                    };
                    key: string;
                    kind: "notify";
                  }
                | {
                    decisions: Array<"approved" | "rejected">;
                    expiresAfterMs?: number;
                    key: string;
                    kind: "decision";
                    makerChecker: boolean;
                    quorum: { approvals: number; kind: "count" };
                  }
                | {
                    approvedStepKey: string;
                    key: string;
                    kind: "branch";
                    rejectedStepKey: string;
                  }
              >;
            };
            workflowId?: string;
          };
        },
        Name
      >;
    };
  };
