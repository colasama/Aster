/** Only a complete pre-begin prefix proves that no export command has executed yet. */
export function initializationCrashedBeforeBegin(step, bytes, prefixLength) {
  if (
    !Number.isInteger(step.exit_code) ||
    step.exit_code >>> 0 !== 0xc0000005 ||
    step.signal !== null ||
    !Number.isSafeInteger(prefixLength) ||
    prefixLength < 1
  )
    return false;
  try {
    const lines = bytes.toString("utf8").split("\n");
    if (lines.pop() !== "" || lines.length !== prefixLength) return false;
    return lines.every((line, index) => {
      if (Buffer.byteLength(line) >= 65536) return false;
      const reply = JSON.parse(line);
      if (reply.version !== 1 || reply.request_id !== index + 1 || reply.payload_bytes !== 0)
        return false;
      return index === 0
        ? reply.response.type === "capabilities" &&
            reply.response.encoder?.hardware_only === true &&
            reply.response.encoder?.test_frame_verified === true
        : reply.response.type === "resource_stored";
    });
  } catch {
    return false;
  }
}
