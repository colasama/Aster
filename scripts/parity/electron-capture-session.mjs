export function captureLogIsFailure(entry) {
  if (entry?.level === "error") return true;
  const label = `${entry?.scope ?? ""} ${entry?.event ?? ""} ${entry?.message ?? ""}`;
  return (
    entry?.event === "audio_analysis_decode_failed" ||
    (entry?.level === "warn" &&
      /gpu|media|video|image|decode/i.test(label) &&
      /failed|error|device.lost/i.test(label))
  );
}

export class CaptureSession {
  #config;
  #store;
  #access;
  #current;
  #index = 0;
  #timer;
  #finish;
  #recover;
  #print;
  #fatal;
  #ready = false;

  constructor(config, host, store, access, options = {}) {
    this.#config = config;
    this.#store = store;
    this.#access = access;
    this.#recover = options.recover;
    this.#print = options.print ?? console.log;
    this.#fatal = options.fatal ?? ((error) => this.abort(error));
    this.report = {
      runId: config.runId,
      status: "passed",
      cases: [],
      host,
      started_at: new Date().toISOString(),
    };
  }

  ready(identity) {
    if (this.#current) throw new Error("Cannot change the adapter during capture");
    const adapter = {};
    for (const key of ["vendor", "architecture", "device", "description"]) {
      if (typeof identity?.[key] !== "string") throw new Error("Invalid WebGPU adapter identity");
      adapter[key] = identity[key];
    }
    if (identity.isFallbackAdapter !== undefined) {
      if (typeof identity.isFallbackAdapter !== "boolean")
        throw new Error("Invalid fallback adapter identity");
      adapter.isFallbackAdapter = identity.isFallbackAdapter;
    }
    const fonts = identity.fonts;
    if (!fonts || !["available", "unavailable"].includes(fonts.status))
      throw new Error("Font identity is required");
    let fontIdentity;
    if (fonts.status === "available") {
      if (
        !/^[a-f0-9]{64}$/.test(fonts.sha256) ||
        !Number.isSafeInteger(fonts.count) ||
        fonts.count < 0
      ) {
        throw new Error("Invalid font identity");
      }
      fontIdentity = { status: fonts.status, sha256: fonts.sha256, count: fonts.count };
    } else {
      if (typeof fonts.reason !== "string") throw new Error("Font availability reason is required");
      fontIdentity = { status: fonts.status, reason: fonts.reason };
    }
    const cache = this.report.host.cacheIdentity;
    if (
      this.#ready &&
      (JSON.stringify(cache.webgpuAdapter) !== JSON.stringify(adapter) ||
        JSON.stringify(cache.fonts) !== JSON.stringify(fontIdentity))
    ) {
      throw new Error("Capture adapter or fonts changed during the run");
    }
    cache.webgpuAdapter = adapter;
    cache.fonts = fontIdentity;
    this.#ready = true;
  }

  async take() {
    if (!this.#ready)
      throw new Error("WebGPU adapter readiness is required before capture or cache lookup");
    if (this.#current) throw new Error("The previous capture case has not completed");
    while (this.#index < this.#config.assignments.length) {
      const assignment = this.#config.assignments[this.#index++];
      const current = {
        assignment,
        frames: new Set(),
        pendingFrames: new Set(),
        preparedFrames: new Set(),
        errors: [],
        started: Date.now(),
        completing: false,
      };
      this.#current = current;
      if (assignment.unavailable) {
        this.#settle("skipped", assignment.unavailable);
        continue;
      }
      this.#timer = setTimeout(() => {
        if (this.#current !== current) return;
        void this.fail({ caseId: assignment.case.id, error: "Capture case timed out" })
          .then(() => this.#recover?.())
          .catch((error) => this.#fatal(error));
      }, this.#config.timeoutMs ?? 300_000);
      try {
        const cached = await this.#store.cached(assignment);
        this.#assertCurrent(current);
        if (cached) {
          this.#settle("cached");
          continue;
        }
        await this.#access.prepare(assignment);
        this.#assertCurrent(current);
        this.#print(`Parity ready: ${assignment.case.id} (${assignment.frames.length} frames)`);
        return assignment;
      } catch (error) {
        if (this.#current?.assignment === assignment)
          await this.fail({ caseId: assignment.case.id, error: error.message });
        else throw error;
      }
    }
    return null;
  }

  #requireCase(payload) {
    if (!this.#current || payload?.caseId !== this.#current.assignment.case.id) {
      throw new Error("Capture payload does not match the active case");
    }
    this.#assertCurrent(this.#current);
    const adapter = this.report.host.cacheIdentity.webgpuAdapter;
    const description = `${adapter.vendor || "GPU"} · ${adapter.description || adapter.device || "WebGPU"}`;
    if (payload.diagnostics?.description !== description) {
      throw new Error("Capture renderer adapter does not match the cache identity");
    }
    return this.#current;
  }

  #assertCurrent(current) {
    if (this.#current !== current) throw new Error("Capture case expired during asynchronous work");
    if (current.errors.length) throw new Error(current.errors.join("\n"));
  }

  async prepareFrame(payload) {
    const current = this.#requireCase(payload);
    if (
      current.completing ||
      !current.assignment.frames.includes(payload.frame) ||
      current.frames.has(payload.frame) ||
      current.pendingFrames.has(payload.frame) ||
      current.preparedFrames.has(payload.frame)
    )
      throw new Error("Unexpected or duplicate frame plan");
    current.pendingFrames.add(payload.frame);
    try {
      const prepared = await this.#store.prepareFrame(current.assignment, payload);
      this.#assertCurrent(current);
      current.preparedFrames.add(payload.frame);
      return prepared;
    } catch (error) {
      if (this.#current === current) current.errors.push(error.message);
      throw error;
    } finally {
      current.pendingFrames.delete(payload.frame);
    }
  }

  async plan(payload) {
    const current = this.#requireCase(payload);
    if (
      !this.#config.planReferences ||
      !current.assignment.planSamples ||
      current.completing ||
      !current.assignment.frames.includes(payload.frame) ||
      current.frames.has(payload.frame) ||
      current.pendingFrames.has(payload.frame) ||
      !current.preparedFrames.has(payload.frame)
    )
      throw new Error("Unexpected or duplicate plan sample");
    current.pendingFrames.add(payload.frame);
    try {
      await this.#store.writePlan(current.assignment, payload);
      this.#assertCurrent(current);
      current.frames.add(payload.frame);
    } catch (error) {
      if (this.#current === current) current.errors.push(error.message);
      throw error;
    } finally {
      current.pendingFrames.delete(payload.frame);
    }
  }

  async frame(payload) {
    if (this.#config.planReferences) throw new Error("Plan capture cannot accept pixel frames");
    const current = this.#requireCase(payload);
    if (
      current.completing ||
      !current.assignment.frames.includes(payload.frame) ||
      current.frames.has(payload.frame) ||
      current.pendingFrames.has(payload.frame)
    ) {
      throw new Error("Unexpected or duplicate capture frame");
    }
    if (this.#config.requireFrameBundles && !current.preparedFrames.has(payload.frame))
      throw new Error("Frame has no prepared native plan");
    const expected = current.assignment.case.size;
    if (
      payload.width !== expected.width ||
      payload.height !== expected.height ||
      !(payload.pixels instanceof ArrayBuffer) ||
      payload.pixels.byteLength !== payload.width * payload.height * 4
    ) {
      throw new Error("Capture frame must contain packed RGBA8 at the requested size");
    }
    current.pendingFrames.add(payload.frame);
    try {
      await this.#store.writeFrame(current.assignment, payload);
      this.#assertCurrent(current);
      current.frames.add(payload.frame);
    } catch (error) {
      if (this.#current === current) current.errors.push(error.message);
      throw error;
    } finally {
      current.pendingFrames.delete(payload.frame);
    }
  }

  async completeCase(payload) {
    const current = this.#requireCase(payload);
    if (current.completing) throw new Error("Capture case completion is already pending");
    if (current.pendingFrames.size || current.frames.size !== current.assignment.frames.length)
      throw new Error("Capture case has missing frames");
    current.completing = true;
    try {
      await this.#store.completeCase(current.assignment, payload);
      this.#assertCurrent(current);
      this.#settle("passed");
    } catch (error) {
      if (this.#current === current) current.errors.push(error.message);
      throw error;
    } finally {
      current.completing = false;
    }
  }

  async fail(payload) {
    if (!payload?.caseId) return this.abort(new Error(payload?.error ?? "Capture renderer failed"));
    if (!this.#current) {
      throw new Error("No capture case is active");
    }
    if (payload?.caseId && payload.caseId !== this.#current.assignment.case.id) {
      throw new Error("Failure does not match the active case");
    }
    const errors = [...this.#current.errors, payload?.error ?? "Capture failed"];
    this.#settle("failed", [...new Set(errors)].join("\n"));
  }

  log(entry) {
    if (!captureLogIsFailure(entry)) return;
    const message = `${entry.scope ?? "renderer"}/${entry.event ?? "error"}: ${entry.error?.message ?? entry.message ?? "capture diagnostic failed"}`;
    if (this.#current) this.#current.errors.push(message);
    else {
      const error = new Error(message);
      this.report.status = "failed";
      this.report.error = error.stack;
      return error;
    }
  }

  #settle(status, error) {
    clearTimeout(this.#timer);
    const current = this.#current;
    this.report.cases.push({
      id: current.assignment.case.id,
      status,
      elapsed_ms: Date.now() - current.started,
      ...(error ? { error } : {}),
    });
    this.#print(`Parity ${status}: ${current.assignment.case.id}${error ? ` — ${error}` : ""}`);
    if (status === "failed" || status === "skipped") this.report.status = "failed";
    this.#current = undefined;
  }

  async rendererLost(error) {
    if (!this.#current) throw error;
    await this.fail({ caseId: this.#current.assignment.case.id, error: error.message });
    await this.#recover?.();
  }

  async done() {
    if (this.#current || this.#index < this.#config.assignments.length) {
      throw new Error("Renderer finished with incomplete capture assignments");
    }
    this.report.finished_at = new Date().toISOString();
    this.#finish = (this.#finish ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.#store.finish(this.report))
      .then(() => this.report);
    return this.#finish;
  }

  async abort(error) {
    clearTimeout(this.#timer);
    this.report.status = "failed";
    this.report.error = error.stack ?? error.message;
    if (this.#current) this.#settle("failed", error.message);
    while (this.#index < this.#config.assignments.length) {
      const assignment = this.#config.assignments[this.#index++];
      this.report.cases.push({
        id: assignment.case.id,
        status: "skipped",
        error: "Capture process could not continue",
      });
    }
    return this.done();
  }
}
