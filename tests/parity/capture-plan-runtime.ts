import {
  activateProjectFonts,
  prepareProjectFonts,
} from "../../src/core/media/project-font-runtime";
import type { RenderSnapshotIdentity } from "../../src/core/rendering/render-snapshot";
import type { Composition, Project } from "../../src/core/types";
import { encodeFramePlan } from "../../src/renderer/frame-plan/codec";
import type { WebGpuRenderer } from "../../src/renderer/webgpu-renderer";
import type { CaptureHealth } from "./capture-health";
import type { ParityCaptureAssignment } from "./capture-protocol";
import { assertCaptureMedia } from "./capture-resources";
import type { CaptureSession } from "./capture-runner";

/** Capture the production evaluator without executing or reading the final beauty graph. */
export function createPlanCaptureSession(options: {
  assignment: ParityCaptureAssignment;
  renderer: WebGpuRenderer;
  project: Project;
  composition: Composition;
  snapshot: RenderSnapshotIdentity;
  health: CaptureHealth;
  dispose(): Promise<void>;
  load_ms: number;
  initialize_ms: number;
}): CaptureSession {
  const { assignment, renderer, project, composition, snapshot, health } = options;
  const assertHealthy = () => {
    assertCaptureMedia(project, composition);
    health.assertHealthy(renderer.diagnostics, renderer.productionRenderError);
  };
  return {
    composition,
    load_ms: options.load_ms,
    initialize_ms: options.initialize_ms,
    diagnostics: () => structuredClone(renderer.diagnostics),
    assertHealthy,
    dispose: options.dispose,
    async readback() {
      throw new Error("Plan reference capture does not produce pixel evidence");
    },
    async plan(time, index) {
      const sample = assignment.planSamples?.samples[index];
      if (!sample || sample.index !== index || sample.time !== time)
        throw new Error("Unrequested plan sample");
      await prepareProjectFonts(project);
      activateProjectFonts(project);
      renderer.configureBeautyTarget(
        assignment.case.size.width,
        assignment.case.size.height,
        assignment.case.aa,
      );
      const bundle = await renderer.planExportFrame(composition, time, snapshot, project, true);
      await renderer.complete();
      assertHealthy();
      const prepare = window.asterParity?.prepareFrame;
      if (!prepare) throw new Error("Plan reference validation is unavailable");
      const prepared = await prepare({
        caseId: assignment.case.id,
        frame: index,
        diagnostics: structuredClone(renderer.diagnostics),
        submitted: encodeFramePlan(bundle.submittedPlan.metadata, bundle.submittedPlan.blobs),
        replay: encodeFramePlan(bundle.plan.metadata, bundle.plan.blobs),
        resources: bundle.resources,
      });
      return {
        caseId: assignment.case.id,
        frame: index,
        time,
        frameRate: { ...composition.frameRate },
        diagnostics: structuredClone(renderer.diagnostics),
        framePlan: prepared.receipt,
        ...(index === 0 ? { project: structuredClone(project) } : {}),
      };
    },
  };
}
