import { describe, expect, it } from "bun:test";

import { clipboardFilePaths, validClipboardRequest } from "./local-clipboard.ts";

/** A drop list and the on-disk sizes of its entries, without a clipboard or a disk. */
function clipboard(sizes: Record<string, number>) {
  return {
    read: async () => Object.keys(sizes),
    sizeOf: async (path: string) => sizes[path],
  };
}

describe("clipboardFilePaths", () => {
  it("answers every file's path in the request's order", async () => {
    const { read, sizeOf } = clipboard({ "C:\\work\\a.txt": 3, "C:\\work\\b dir\\b.png": 10 });
    expect(await clipboardFilePaths([{ name: "b.png", size: 10 }, { name: "a.txt", size: 3 }], read, sizeOf))
      .toEqual(["C:\\work\\b dir\\b.png", "C:\\work\\a.txt"]);
  });

  it("answers null when one file's size differs", async () => {
    const { read, sizeOf } = clipboard({ "C:\\work\\a.txt": 3, "C:\\work\\b.png": 10 });
    expect(await clipboardFilePaths([{ name: "a.txt", size: 3 }, { name: "b.png", size: 11 }], read, sizeOf)).toBeNull();
  });

  it("matches a name twice only against two entries", async () => {
    const one = clipboard({ "C:\\x\\same.txt": 5 });
    expect(await clipboardFilePaths([{ name: "same.txt", size: 5 }, { name: "same.txt", size: 5 }], one.read, one.sizeOf)).toBeNull();
    const two = clipboard({ "C:\\x\\same.txt": 5, "D:\\y\\same.txt": 5 });
    expect(await clipboardFilePaths([{ name: "same.txt", size: 5 }, { name: "same.txt", size: 5 }], two.read, two.sizeOf))
      .toEqual(["C:\\x\\same.txt", "D:\\y\\same.txt"]);
  });

  it("matches a decomposed (NFD) name against a composed (NFC) one", async () => {
    const composed = "보고서.txt".normalize("NFC");
    const { read, sizeOf } = clipboard({ [`C:\\문서\\${composed}`]: 7 });
    expect(await clipboardFilePaths([{ name: composed.normalize("NFD"), size: 7 }], read, sizeOf)).toEqual([`C:\\문서\\${composed}`]);
  });

  it("answers null for an empty drop list", async () => {
    expect(await clipboardFilePaths([{ name: "a.txt", size: 1 }], async () => [], async () => 1)).toBeNull();
  });

  it("takes a Windows path's name after the last backslash, also on POSIX", async () => {
    const { read, sizeOf } = clipboard({ "C:\\it's $here\\a.txt": 2, "\\\\server\\share\\b.txt": 4 });
    expect(await clipboardFilePaths([{ name: "b.txt", size: 4 }, { name: "a.txt", size: 2 }], read, sizeOf))
      .toEqual(["\\\\server\\share\\b.txt", "C:\\it's $here\\a.txt"]);
    expect(await clipboardFilePaths([{ name: "C:\\it's $here\\a.txt", size: 2 }], read, sizeOf)).toBeNull();
  });
});

describe("validClipboardRequest", () => {
  const file = { name: "a.txt", size: 0 };

  it("accepts one to twenty named files with whole non-negative sizes", () => {
    expect(validClipboardRequest({ files: [file] })).toEqual([file]);
    expect(validClipboardRequest({ files: Array.from({ length: 20 }, () => file) })).toHaveLength(20);
    expect(validClipboardRequest({ files: [{ name: "x".repeat(255), size: Number.MAX_SAFE_INTEGER }] })).toHaveLength(1);
  });

  it("rejects anything else", () => {
    for (const body of [
      null, [file], "files", {}, { files: file }, { files: [] },
      { files: Array.from({ length: 21 }, () => file) },
      { files: [null] }, { files: [{ size: 1 }] }, { files: [{ name: "", size: 1 }] }, { files: [{ name: "x".repeat(256), size: 1 }] },
      { files: [{ name: "a", size: -1 }] }, { files: [{ name: "a", size: 1.5 }] }, { files: [{ name: "a", size: "1" }] },
      { files: [{ name: "a" }] }, { files: [{ name: "a", size: Number.MAX_SAFE_INTEGER + 1 }] },
    ]) expect(validClipboardRequest(body)).toBeNull();
  });
});
