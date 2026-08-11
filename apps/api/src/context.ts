/**
 * Request context and workspace scoping.
 *
 * Every data-touching route resolves a workspace first. Row-level isolation is
 * enforced by always filtering on `workspace_id` in the repository layer, so a
 * missing scope is a 401 rather than a query that quietly spans tenants
 * (PRD §34).
 */

import type { Client } from '@outreachgraph/db';

export interface RequestActor {
  readonly userId: string;
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly role: 'owner' | 'admin' | 'member' | 'viewer';
}

export interface AppEnv {
  Variables: {
    db: Client;
    actor: RequestActor;
    requestId: string;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static notFound(what: string): ApiError {
    return new ApiError(404, 'not_found', `${what} not found`);
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, 'bad_request', message, details);
  }

  static unauthorized(message = 'authentication required'): ApiError {
    return new ApiError(401, 'unauthorized', message);
  }

  static forbidden(message: string): ApiError {
    return new ApiError(403, 'forbidden', message);
  }

  /**
   * A policy denial. 409 rather than 403: the request is well-formed and the
   * caller is authorised — the action is simply not permitted right now, and
   * the reason is actionable.
   */
  static policyDenied(reason: string, details?: unknown): ApiError {
    return new ApiError(409, 'policy_denied', reason, details);
  }
}

/** Roles permitted to approve outbound actions. */
export function canApprove(actor: RequestActor): boolean {
  return actor.role === 'owner' || actor.role === 'admin' || actor.role === 'member';
}
