import { NativeRenderClient } from "./native-render-client.js";
import type { NativeSessionReply, NativeVideoConfig } from "./native-render-protocol.js";

/** Qualify one retained hardware encoder before any plan admission or output publication. */
export async function prepareNativeEncoder(options: {
  binary: string;
  args: string[];
  video: NativeVideoConfig;
  frameCount: number;
  own(client: NativeRenderClient): void;
  assertActive(): void;
}): Promise<{ client: NativeRenderClient; reply: NativeSessionReply }> {
  let sharedFailure: string | undefined;
  for (const mode of ["--native-export", "--native-readback-export"]) {
    options.assertActive();
    const client = new NativeRenderClient({
      executable: options.binary,
      args: ["serve", mode, ...options.args],
    });
    options.own(client);
    let initializingTransport = false;
    try {
      const probe = await client.request({
        type: "probe",
        adapter_luid: null,
        video: options.video,
      });
      const encoder = probe.response.encoder as Record<string, unknown> | undefined;
      if (encoder?.test_frame_verified !== true)
        throw new Error("Native hardware encoder did not verify a frame");
      options.assertActive();
      initializingTransport = true;
      const reply = await client.request({
        type: "begin_export",
        video: options.video,
        frame_count: options.frameCount,
      });
      reply.response.adapter = probe.response.adapter;
      reply.response.probed_adapter_luid = probe.response.adapter_luid;
      options.assertActive();
      if (sharedFailure) {
        if (reply.response.transport !== "nv12-readback")
          throw new Error("Native fallback did not select NV12 readback");
        reply.response.transport_reason = sharedFailure;
      }
      return { client, reply };
    } catch (error) {
      await client.dispose();
      options.assertActive();
      if (!initializingTransport || mode !== "--native-export") {
        if (sharedFailure)
          throw new Error(
            `${sharedFailure}; native readback initialization failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        throw error;
      }
      // A crashed driver cannot recover in its original process. Requalify in a fresh sidecar,
      // retaining GPU rendering and hardware encoding while avoiding shared D3D11 input.
      sharedFailure = `Shared transport initialization failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  throw new Error("Native encoder initialization exhausted its bounded attempts");
}
