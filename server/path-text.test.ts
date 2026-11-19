import { describe, expect, it } from "bun:test";

import { shellText, UnsafePathError, validPaths } from "./path-text.ts";

const SHELLS = ["posix", "powershell", "cmd", "unknown"] as const;

describe("shellText", () => {
  it("leaves a plain path bare in each shell's own set", () => {
    expect(shellText("posix", ["/home/u/보고서_v1.2-final.txt"])).toBe("/home/u/보고서_v1.2-final.txt ");
    expect(shellText("powershell", ["C:\\work\\보고서.txt"])).toBe("C:\\work\\보고서.txt ");
    expect(shellText("cmd", ["C:\\work\\a.txt"])).toBe("C:\\work\\a.txt ");
  });

  it("quotes a backslash for a POSIX shell, which would eat it bare", () => {
    expect(shellText("posix", ["/tmp/a\\b.txt"])).toBe("'/tmp/a\\b.txt' ");
  });

  it("quotes for PowerShell with every single quote doubled, curly ones included", () => {
    expect(shellText("powershell", ["C:\\it's\\a.txt"])).toBe("'C:\\it''s\\a.txt' ");
    expect(shellText("powershell", ["C:\\a b\\x.txt"])).toBe("'C:\\a b\\x.txt' ");
    expect(shellText("powershell", ["C:\\$(whoami)\\x.txt"])).toBe("'C:\\$(whoami)\\x.txt' ");
    expect(shellText("powershell", ["C:\\a\u2019b.txt"])).toBe("'C:\\a\u2019\u2019b.txt' ");
  });

  it("quotes for cmd.exe in double quotes, so & is no command separator", () => {
    expect(shellText("cmd", ["C:\\a b\\x.txt"])).toBe("\"C:\\a b\\x.txt\" ");
    expect(shellText("cmd", ["C:\\tmp\\a&whoami&b.txt"])).toBe("\"C:\\tmp\\a&whoami&b.txt\" ");
  });

  it("refuses for cmd.exe a path holding %, ! or \"", () => {
    expect(() => shellText("cmd", ["C:\\%PATH%\\a.txt"])).toThrow(UnsafePathError);
    // with delayed expansion on, !NAME! expands inside double quotes too
    expect(() => shellText("cmd", ["C:\\tmp\\a!USERNAME!b.txt"])).toThrow(UnsafePathError);
    expect(() => shellText("cmd", ["C:\\a\"b.txt"])).toThrow(UnsafePathError);
  });

  it("quotes for a POSIX shell with a single quote closed, escaped and reopened", () => {
    expect(shellText("posix", ["/tmp/it's.txt"])).toBe("'/tmp/it'\\''s.txt' ");
  });

  it("refuses a control character in every shell", () => {
    for (const shell of SHELLS) {
      for (const control of ["\n", "\r", "\u001B", "\u0015", "\u007F", "\u0085"]) {
        expect(() => shellText(shell, [`/tmp/a${control}b.txt`])).toThrow(UnsafePathError);
      }
    }
  });

  it("refuses the bracketed-paste breakout name instead of typing it", () => {
    let error: unknown;
    try { shellText("posix", ["/tmp/\u001B[201~\u0015whoami\r"]); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(UnsafePathError);
    expect((error as UnsafePathError).code).toBe("unsafe_path");
  });

  it("takes only a plain path for an unknown shell", () => {
    expect(shellText("unknown", ["/home/u/a.txt"])).toBe("/home/u/a.txt ");
    expect(() => shellText("unknown", ["/home/u/a b.txt"])).toThrow(UnsafePathError);
    expect(() => shellText("unknown", ["/home/u/it's.txt"])).toThrow(UnsafePathError);
  });

  it("refuses a backslash for an unknown shell, which may be Git Bash on Windows", () => {
    expect(() => shellText("unknown", ["C:\\work\\a.txt"])).toThrow(UnsafePathError);
    expect(() => shellText("unknown", ["\\\\server\\share\\a.txt"])).toThrow(UnsafePathError);
    expect(() => shellText("unknown", ["/tmp/a\\b.txt"])).toThrow(UnsafePathError);
  });

  it("joins the paths with one space and ends with one", () => {
    expect(shellText("posix", ["/a.txt", "/b c.txt"])).toBe("/a.txt '/b c.txt' ");
  });
});

describe("validPaths", () => {
  it("accepts one to twenty non-empty paths of at most 4096 characters", () => {
    expect(validPaths(["/a"])).toEqual(["/a"]);
    expect(validPaths(Array.from({ length: 20 }, () => "/a"))).toHaveLength(20);
    expect(validPaths(["x".repeat(4096)])).toHaveLength(1);
  });

  it("rejects anything else", () => {
    for (const value of [undefined, null, "/a", [], Array.from({ length: 21 }, () => "/a"), [""], ["x".repeat(4097)], [1], ["/a", null]]) {
      expect(validPaths(value)).toBeNull();
    }
  });
});
