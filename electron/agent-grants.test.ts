import { describe, expect, it, vi } from "vitest";
import { FullAccessGrantManager } from "./agent-grants";

const activation = {
  projectId: "project-1",
  projectName: "Launch",
  model: "model-1",
  providerBaseUrl: "https://provider.example/v1",
  confirmation: "Launch",
};

describe("Full Access grants", () => {
  it("requires typed confirmation and a separate native warning", async () => {
    const manager = new FullAccessGrantManager();
    const warning = vi.fn(async () => true);
    await expect(
      manager.activate(1, { ...activation, confirmation: "yes" }, warning),
    ).rejects.toThrow("confirmation");
    expect(warning).not.toHaveBeenCalled();
    const grant = await manager.activate(1, activation, warning);
    expect(warning).toHaveBeenCalledOnce();
    expect(
      manager.require(
        1,
        grant.id,
        activation.projectId,
        activation.model,
        activation.providerBaseUrl,
      ),
    ).toEqual(grant);
  });

  it("cannot be widened across owner, project, model, or provider", async () => {
    const manager = new FullAccessGrantManager();
    const grant = await manager.activate(1, activation, async () => true);
    expect(() =>
      manager.require(
        2,
        grant.id,
        activation.projectId,
        activation.model,
        activation.providerBaseUrl,
      ),
    ).toThrow("not active");
    expect(() =>
      manager.require(1, grant.id, "other", activation.model, activation.providerBaseUrl),
    ).toThrow("scope");
    expect(() =>
      manager.require(1, grant.id, activation.projectId, "other", activation.providerBaseUrl),
    ).toThrow("scope");
  });

  it("expires and revokes immediately", async () => {
    const manager = new FullAccessGrantManager(5);
    const grant = await manager.activate(1, activation, async () => true);
    expect(manager.revoke(1, grant.id)).toBe(true);
    expect(() =>
      manager.require(
        1,
        grant.id,
        activation.projectId,
        activation.model,
        activation.providerBaseUrl,
      ),
    ).toThrow("not active");
    const expiring = await manager.activate(1, activation, async () => true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(() =>
      manager.require(
        1,
        expiring.id,
        activation.projectId,
        activation.model,
        activation.providerBaseUrl,
      ),
    ).toThrow("expired");
  });
});
