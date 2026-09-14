import { describe, it, expect } from "vitest";
import {
  ACCEPTED_MIME,
  PICKER_ACCEPT,
  firstAttachable,
  kindForFile,
} from "./attachments";

function makeFile(name: string, type: string): File {
  return new File(["x"], name, { type });
}

describe("kindForFile", () => {
  it("classifies a pasted screenshot as an image", () => {
    // macOS/Windows/Linux all put screenshots on the clipboard as PNG.
    expect(kindForFile(makeFile("screenshot.png", "image/png"))).toBe("image");
  });

  it("classifies each accepted mime under its own kind", () => {
    for (const kind of ["image", "video", "document"] as const) {
      for (const mime of ACCEPTED_MIME[kind]) {
        expect(kindForFile(makeFile("f", mime))).toBe(kind);
      }
    }
  });

  it("tolerates a parameterised mime", () => {
    // Firefox appends a charset when pasting plain text as a file.
    expect(kindForFile(makeFile("notes.txt", "text/plain;charset=utf-8"))).toBe(
      "document",
    );
  });

  it("is case-insensitive", () => {
    expect(kindForFile(makeFile("a.PNG", "IMAGE/PNG"))).toBe("image");
  });

  it("rejects a type the storage bucket would refuse", () => {
    expect(kindForFile(makeFile("clip.mov", "video/quicktime"))).toBeNull();
    expect(kindForFile(makeFile("archive.zip", "application/zip"))).toBeNull();
  });

  it("rejects a file the OS gave no type for", () => {
    // Dragging an extensionless file yields type: "".
    expect(kindForFile(makeFile("README", ""))).toBeNull();
  });

  it("never classifies audio — the recorder owns that path", () => {
    expect(kindForFile(makeFile("voice.ogg", "audio/ogg"))).toBeNull();
  });
});

describe("firstAttachable", () => {
  it("returns the first acceptable file in the batch", () => {
    const png = makeFile("a.png", "image/png");
    const pdf = makeFile("b.pdf", "application/pdf");
    expect(firstAttachable([png, pdf])).toEqual({ file: png, kind: "image" });
  });

  it("skips unsupported files rather than refusing the whole drop", () => {
    const zip = makeFile("a.zip", "application/zip");
    const pdf = makeFile("b.pdf", "application/pdf");
    expect(firstAttachable([zip, pdf])).toEqual({ file: pdf, kind: "document" });
  });

  it("returns null when nothing in the batch is acceptable", () => {
    expect(firstAttachable([makeFile("a.zip", "application/zip")])).toBeNull();
  });

  it("returns null for an empty batch", () => {
    expect(firstAttachable([])).toBeNull();
  });
});

describe("PICKER_ACCEPT", () => {
  it("is derived from the same table the drop path reads", () => {
    // Guards the drift this module exists to prevent: a type the picker
    // offers must be one a drop accepts.
    for (const kind of ["image", "video", "document"] as const) {
      const offered = PICKER_ACCEPT[kind].split(",");
      expect(offered).toEqual([...ACCEPTED_MIME[kind]]);
      for (const mime of offered) {
        expect(kindForFile(makeFile("f", mime))).toBe(kind);
      }
    }
  });
});
