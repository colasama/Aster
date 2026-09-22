import { AiCommandBatch } from "./command-normalizer";
import { editErrorData } from "./edit-limits";
import type { EditTask, EditTaskResult } from "./edit-task";
import { executeScript } from "./script-runtime";

self.onmessage = async ({ data }: MessageEvent<EditTask>) => {
  try {
    let value: EditTaskResult;
    if (data.commands) {
      const batch = new AiCommandBatch(data.project, data.currentTime, data.maxOperations);
      for (const command of data.commands) batch.append(command);
      value = { ...batch.finish(), result: null };
    } else {
      if (typeof data.code !== "string") throw new Error("Missing script body");
      value = await executeScript({ ...data, code: data.code }, (value) =>
        self.postMessage({ type: "progress", value }),
      );
    }
    self.postMessage({ type: "result", value });
  } catch (error) {
    self.postMessage({ type: "error", error: editErrorData(error) });
  }
};
