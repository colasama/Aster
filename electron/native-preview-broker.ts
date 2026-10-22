import { type SharedTextureImported, sharedTexture, type WebFrameMain } from "electron";
import type { NativePreviewClient, NativePreviewFrame } from "./native-preview-client.js";

interface PreviewPresentation {
  sequence: number;
  time: number | null;
  render_and_share_ms: number;
  timings?: NativePreviewFrame["timings"];
}

interface ImportLease {
  texture: SharedTextureImported;
  released: boolean;
  completion: Promise<void>;
}

/** Main-process texture ownership stays private; the renderer receives only a VideoFrame. */
export class NativePreviewBroker {
  readonly #client: NativePreviewClient;
  readonly #leases = new Map<number, ImportLease>();
  #pending?: Promise<PreviewPresentation>;
  #closing?: Promise<void>;
  #replacing?: Promise<void>;
  #failure?: Error;

  constructor(client: NativePreviewClient) {
    this.#client = client;
  }

  present(
    frame: WebFrameMain,
    identity: Readonly<Record<string, unknown>>,
    time?: number,
  ): Promise<PreviewPresentation> {
    if (this.#closing || this.#failure)
      return Promise.reject(this.#failure ?? new Error("Preview is closing"));
    if (this.#pending || this.#replacing)
      return Promise.reject(new Error("A preview presentation is already pending"));
    const ownedIdentity = structuredClone(identity);
    const pending = this.#present(frame, ownedIdentity, time).finally(() => {
      if (this.#pending === pending) this.#pending = undefined;
    });
    this.#pending = pending;
    return pending;
  }

  async #present(
    frame: WebFrameMain,
    identity: Readonly<Record<string, unknown>>,
    time?: number,
  ): Promise<PreviewPresentation> {
    await this.#client.ready;
    const ready = this.#client.current;
    if (this.#leases.size >= ready.slots) {
      const oldest = this.#leases.values().next().value;
      if (oldest) await this.#released(oldest.completion);
    }
    if (this.#closing || this.#failure) throw this.#failure ?? new Error("Preview is closing");
    const reply = await this.#client.present(time);
    let resolveRelease: () => void = () => undefined;
    let rejectRelease: (error: Error) => void = () => undefined;
    const completion = new Promise<void>((resolve, reject) => {
      resolveRelease = resolve;
      rejectRelease = reject;
    });
    // Observe rejection even if a failing transfer has no later caller waiting for capacity.
    void completion.catch((error: unknown) => {
      this.#failure = error instanceof Error ? error : new Error(String(error));
    });
    let texture: SharedTextureImported;
    let releaseRequested = false;
    const release = () => {
      if (releaseRequested) return;
      releaseRequested = true;
      void this.#client.release(reply.sequence).then(
        () => {
          this.#leases.delete(reply.sequence);
          resolveRelease();
        },
        (error: unknown) => {
          rejectRelease(error instanceof Error ? error : new Error(String(error)));
        },
      );
    };
    try {
      texture = sharedTexture.importSharedTexture({
        textureInfo: {
          codedSize: { width: ready.width, height: ready.height },
          handle: { ntHandle: Buffer.from(reply.nt_handle) },
          pixelFormat: "bgra",
          colorSpace: { primaries: "bt709", transfer: "srgb", matrix: "rgb", range: "full" },
          timestamp: reply.sequence,
        },
        allReferencesReleased: release,
      });
    } catch (error) {
      release();
      await this.#released(completion);
      throw error;
    }
    const lease = { texture, released: false, completion };
    this.#leases.set(reply.sequence, lease);
    try {
      await sharedTexture.sendSharedTexture(
        { frame, importedSharedTexture: texture },
        {
          ...identity,
          sequence: reply.sequence,
          generation: reply.generation,
          time: reply.time,
          source: ready.source,
          width: ready.width,
          height: ready.height,
        },
      );
    } finally {
      lease.released = true;
      texture.release();
    }
    // Electron retains VideoFrame resources through GPU completion. A presentation is
    // complete only after every import reference and the producer's lease have drained.
    await this.#released(completion);
    return {
      sequence: reply.sequence,
      time: reply.time,
      render_and_share_ms: reply.render_and_share_ms,
      timings: reply.timings,
    };
  }

  async #released(completion: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Preview GPU references did not drain")),
            30000,
          );
        }),
      ]);
    } catch (error) {
      this.#failure = error instanceof Error ? error : new Error(String(error));
      this.#client.abort("Preview GPU release failed");
      throw this.#failure;
    } finally {
      clearTimeout(timer);
    }
  }

  replace(project: string, request: string): Promise<void> {
    if (this.#closing || this.#failure || this.#replacing)
      return Promise.reject(this.#failure ?? new Error("Preview cannot replace its snapshot now"));
    const pending = (async () => {
      await this.#pending;
      await this.#released(
        Promise.all([...this.#leases.values()].map((lease) => lease.completion)).then(
          () => undefined,
        ),
      );
      if (this.#closing || this.#failure) throw this.#failure ?? new Error("Preview is closing");
      await this.#client.replace(project, request);
    })().finally(() => {
      if (this.#replacing === pending) this.#replacing = undefined;
    });
    this.#replacing = pending;
    return pending;
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const drained = (async () => {
        await this.#pending?.catch(() => undefined);
        await this.#replacing?.catch(() => undefined);
        for (const lease of this.#leases.values()) {
          if (!lease.released) {
            lease.released = true;
            lease.texture.release();
          }
        }
        await Promise.all([...this.#leases.values()].map((lease) => lease.completion));
        if (this.#failure) throw this.#failure;
        await this.#client.close();
      })();
      await Promise.race([
        drained,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Preview GPU references did not drain")),
            30000,
          );
        }),
      ]);
    } catch (error) {
      this.#client.abort("Preview broker closed after transport failure");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
