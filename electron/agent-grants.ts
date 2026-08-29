import type { FullAccessActivationRequest, FullAccessGrant } from "../src/ai/agent-protocol.js";

const DEFAULT_GRANT_LIFETIME_MS = 30 * 60 * 1000;

interface StoredGrant extends FullAccessGrant {
  ownerId: number;
}

export class FullAccessGrantManager {
  readonly #grants = new Map<string, StoredGrant>();
  readonly #lifetimeMs: number;

  constructor(lifetimeMs = DEFAULT_GRANT_LIFETIME_MS) {
    this.#lifetimeMs = lifetimeMs;
  }

  async activate(
    ownerId: number,
    request: FullAccessActivationRequest,
    showNativeWarning: () => Promise<boolean>,
  ): Promise<FullAccessGrant> {
    validateActivation(request);
    const expected = request.projectName.trim();
    if (request.confirmation !== expected && request.confirmation !== "FULL ACCESS")
      throw new Error("Full Access confirmation does not match the project name or FULL ACCESS");
    if (!(await showNativeWarning())) throw new Error("Full Access activation was cancelled");
    this.revokeOwner(ownerId);
    const grant: StoredGrant = {
      id: crypto.randomUUID(),
      ownerId,
      projectId: request.projectId,
      model: request.model,
      providerHost: new URL(request.providerBaseUrl).host,
      expiresAt: new Date(Date.now() + this.#lifetimeMs).toISOString(),
    };
    this.#grants.set(grant.id, grant);
    return publicGrant(grant);
  }

  require(
    ownerId: number,
    grantId: string | undefined,
    projectId: string,
    model: string,
    providerBaseUrl: string,
  ): FullAccessGrant {
    const grant = grantId ? this.#grants.get(grantId) : undefined;
    if (!grant || grant.ownerId !== ownerId) throw new Error("Full Access grant is not active");
    if (Date.parse(grant.expiresAt) <= Date.now()) {
      this.#grants.delete(grant.id);
      throw new Error("Full Access grant expired");
    }
    if (
      grant.projectId !== projectId ||
      grant.model !== model ||
      grant.providerHost !== new URL(providerBaseUrl).host
    )
      throw new Error("Full Access grant scope does not match this agent request");
    return publicGrant(grant);
  }

  requireActive(ownerId: number, grantId: string | undefined): FullAccessGrant {
    const grant = grantId ? this.#grants.get(grantId) : undefined;
    if (!grant || grant.ownerId !== ownerId) throw new Error("Full Access grant is not active");
    if (Date.parse(grant.expiresAt) <= Date.now()) {
      this.#grants.delete(grant.id);
      throw new Error("Full Access grant expired");
    }
    return publicGrant(grant);
  }

  revoke(ownerId: number, grantId: string): boolean {
    const grant = this.#grants.get(grantId);
    if (!grant || grant.ownerId !== ownerId) return false;
    return this.#grants.delete(grantId);
  }

  revokeOwner(ownerId: number): string[] {
    const revoked: string[] = [];
    for (const [grantId, grant] of this.#grants) {
      if (grant.ownerId !== ownerId) continue;
      this.#grants.delete(grantId);
      revoked.push(grantId);
    }
    return revoked;
  }
}

function validateActivation(request: FullAccessActivationRequest): void {
  if (!request.projectId.trim() || !request.projectName.trim() || !request.model.trim())
    throw new Error("Full Access activation scope is incomplete");
  const provider = new URL(request.providerBaseUrl);
  if (
    provider.protocol !== "https:" &&
    !(
      provider.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(provider.hostname)
    )
  )
    throw new Error("Full Access provider must use HTTPS or loopback HTTP");
}

function publicGrant(grant: StoredGrant): FullAccessGrant {
  return {
    id: grant.id,
    projectId: grant.projectId,
    model: grant.model,
    providerHost: grant.providerHost,
    expiresAt: grant.expiresAt,
  };
}
