(() => {
  const bytes = Uint8Array.from(atob("ENCODED_DOCUMENT"), (c) =>
    c.charCodeAt(0),
  );
  const { compiled, snapshot } = JSON.parse(new TextDecoder().decode(bytes));
  if (compiled) {
    // Source instructions retain the operands, angles and IDs of every gate.
    // Studio owns every export except this specific set of imported frames.
    const engine = globalThis.QCCD;
    const importedFrames = P.frames;
    const exportFrames = engine.framesToTsir;
    engine.framesToTsir = function (frames, device, classes, name, archSpec) {
      if (frames === importedFrames) {
        return { ...compiled, name, arch_spec: archSpec };
      }
      return exportFrames(frames, device, classes, name, archSpec);
    };
    return;
  }
  const result = globalThis.EDITOR.restore(snapshot);
  if (result.ok && Number.isInteger(snapshot.saved_at_frame)) {
    globalThis.EDITOR.seekTo(snapshot.saved_at_frame);
  } else if (!result.ok) {
    const error = document.createElement("p");
    error.setAttribute("role", "alert");
    error.textContent =
      "Studio could not restore the source edits: " +
      result.problems.map((p) => p.message).join(", ");
    document.body.prepend(error);
  }
})();
