/**
 * Bionic reading for live terminal output (Settings › Terminal). The start of each word, Korean
 * included, is drawn bold (ESC[1m) and the rest dim (ESC[2m) before xterm draws it. Only the drawing
 * changes: the bytes the program sent, the buffer text, copy and search stay the same.
 *
 * The transformer is stateful per pane: escape sequences split across chunks pass through
 * untouched, and text the program already made bold is left alone. A word cut by a chunk
 * boundary is treated as two words (ponytail: rare, and only the bold split moves).
 * text-vide (MIT) computes the same fixation but knows nothing of escape sequences, which it
 * would break; the formula below is the one line it would have given us.
 */
const WORD = /[\p{L}\p{M}\p{N}]/u;
const BOLD = "\x1b[1m", NORMAL = "\x1b[22m", DIM = "\x1b[2m";

/** how many leading characters to bold: 1 for short words, about 40% for longer ones */
export function fixation(length: number): number {
  return length <= 1 ? 0 : length <= 3 ? 1 : Math.ceil(length * 0.4);
}

type State = "text" | "esc" | "inter" | "csi" | "str" | "strEsc";

export function createBionic(): (chunk: string, enabled: boolean) => string {
  let state: State = "text", params = "", bold = false, dim = false;
  const sgr = (list: string) => {
    const codes = list === "" ? [0] : list.split(";").map((token) => Number.parseInt(token, 10) || 0);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code === 0) bold = dim = false;
      else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 22) bold = dim = false;
      else if ((code === 38 || code === 48 || code === 58) && !list.includes(":")) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
    }
  };
  return (chunk, enabled) => {
    let out = "", word = "";
    const flush = () => {
      const chars = [...word], head = enabled && !bold ? fixation(chars.length) : 0;
      // the rest is dimmed too: Hangul fonts draw bold barely heavier, so bold alone hardly shows
      out += head === 0 ? word : BOLD + chars.slice(0, head).join("") + NORMAL + DIM + chars.slice(head).join("") + (dim ? "" : NORMAL);
      word = "";
    };
    for (const ch of chunk) {
      if (state === "text") {
        if (WORD.test(ch)) { word += ch; continue; }
        flush();
        if (ch === "\x1b") state = "esc";
        out += ch;
        continue;
      }
      out += ch;
      if (state === "esc") state = ch === "[" ? (params = "", "csi") : "]P^_X".includes(ch) ? "str" : ch >= " " && ch <= "/" ? "inter" : "text";
      else if (state === "inter") { if (!(ch >= " " && ch <= "/")) state = "text"; }
      else if (state === "csi") {
        if (ch >= "@" && ch <= "~") { if (ch === "m") sgr(params); state = "text"; } else params += ch;
      } else if (state === "str") { if (ch === "\x07") state = "text"; else if (ch === "\x1b") state = "strEsc"; }
      else state = ch === "\\" ? "text" : "str";
    }
    flush();
    return out;
  };
}
