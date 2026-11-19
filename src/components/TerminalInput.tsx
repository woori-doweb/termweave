import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { CornerDownLeft, ImagePlus, SendHorizontal } from "lucide-react";

import "./TerminalInput.css";
import { readTerminalDraft, writeTerminalDraft, TERMINAL_LINE_LIMIT, subscribeTerminalDraft, terminalDraftSending, setTerminalDraftSending, acknowledgeTerminalDraft } from "../lib/terminalDraft.ts";

import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { ApiError, localClipboardPaths, paneText } from "../lib/api.ts";
import { MAX_INSERT_FILES } from "../../shared/insert-files.ts";
import { MicButton, VoiceRecordingPill, useDictation } from "./VoiceInput.tsx";

export interface TerminalInputProps {
  owner: string;
  /** the pane an attached image is saved beside */
  paneId: string;
  onComposing?: (active: boolean) => void;
  connected: boolean;
  /** true: sent, clear the line; a string: keep the text and say why; false: not sent (offline) */
  onSend: (text: string) => false | Promise<true | string>;
  /** an empty line's send: Enter alone, for a menu's default or a prompt that asks to continue */
  onEnter: () => boolean;
  /** set to this line's break: the key bar's Enter calls it (a keyboard such as Samsung's Cheonjiin has no Enter) */
  lineBreakRef?: { current: (() => void) | null };
  /** set to this line's path insert: the header's file picker puts the paths it picked at the caret */
  insertPathsRef?: { current: ((paths: string[]) => void) | null };
}

/** Lines the box grows to before it scrolls. */
const MAX_ROWS = 4;

/**
 * The terminal's input line on a touch screen. A phone's keyboard rewrites what it typed
 * (dictation revising a phrase, an IME finishing a syllable, autocorrect), and a terminal
 * cannot take back keys it already sent: every revision arrived as more text. Here the line
 * is written with the keyboard's own editing and goes to the pane whole, then Enter.
 */
export function TerminalInput({ owner, paneId, connected, onSend, onEnter, onComposing, lineBreakRef, insertPathsRef }: TerminalInputProps) {
  const t = useT();
  const text = useSyncExternalStore(subscribeTerminalDraft, () => readTerminalDraft(owner));
  const setText = useCallback((value: string | ((previous: string) => string)) => {
    // Read the owner record even after unmount: a late acknowledgement must not erase
    // edits made in a newly mounted input for the same pane.
    const next = typeof value === "function" ? value(readTerminalDraft(owner)) : value;
    writeTerminalDraft(owner, next);

  }, [owner]);
  const composing = useRef(false);
  const composingCallback = useRef(onComposing);
  composingCallback.current = onComposing;
  useEffect(() => () => { composingCallback.current?.(false); }, []);

  const [note, setNote] = useState<string | null>(null);
  const sending = useSyncExternalStore(subscribeTerminalDraft, () => terminalDraftSending(owner));
  const box = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const { settings } = useSettings();
  const dictation = useDictation({
    mode: "terminal",
    connected,
    polish: settings.voicePolishTerminal,
    box,
    read: () => textRef.current,
    write: (value, caret) => {
      textRef.current = value;
      setText(value);
      requestAnimationFrame(() => {
        const element = box.current;
        if (!element) return;
        element.selectionStart = element.selectionEnd = caret;
        // without focus the browser does not follow the caret: a wrapped dictation's end would stay hidden
        if (caret === element.value.length) element.scrollTop = element.scrollHeight;
      });
    },
    onNote: setNote,
  });

  // The caret an edit of ours put down, until the frame that draws it: the box shows the new text
  // only after React renders, so a second edit in the same commit (a path, then the key bar's
  // Enter) would read the old caret and selection from the box.
  const pendingCaret = useRef<number | null>(null);
  const selection = (value: string): [number, number] => {
    if (pendingCaret.current !== null) { const caret = Math.min(pendingCaret.current, value.length); return [caret, caret]; }
    const element = box.current;
    const start = Math.min(element?.selectionStart ?? value.length, value.length);
    return [start, Math.max(start, Math.min(element?.selectionEnd ?? start, value.length))];
  };
  const placeCaret = (element: HTMLTextAreaElement, caret: number, length: number): void => {
    pendingCaret.current = caret;
    requestAnimationFrame(() => {
      element.selectionStart = element.selectionEnd = caret;
      if (caret === length) element.scrollTop = element.scrollHeight;
      if (pendingCaret.current === caret) pendingCaret.current = null;
    });
  };

  // a fragment at the caret, over a selection, a space apart from the word before it; the
  // caret follows it and the box keeps the keyboard so typing goes on after it
  const insertAtCaret = (fragment: string): void => {
    const element = box.current;
    const value = readTerminalDraft(owner);
    const [start, end] = selection(value);
    const before = value.slice(0, start);
    const inserted = before && !/\s$/.test(before) ? ` ${fragment}` : fragment;
    const next = `${before}${inserted}${value.slice(end)}`;
    if (next.length > TERMINAL_LINE_LIMIT) { setNote(t("The path does not fit in the box")); return; }
    textRef.current = next;
    setText(next);
    setNote(null);
    if (!element) return;
    if (document.activeElement !== element) element.focus({ preventScroll: true });
    placeCaret(element, start + inserted.length, next.length);
  };
  const insertAtCaretLatest = useRef(insertAtCaret);
  insertAtCaretLatest.current = insertAtCaret;

  // a phone has no drop or file paste: pick photos, save them beside the pane, and put their
  // quoted paths in the line so a message can go with them (the agent reads a path as an image).
  // A file Explorer copied on this PC keeps its own path: the server reads it from the clipboard.
  const machineId = useMachineId();
  const { uploadPaneImage } = useMachineApi();
  const picker = useRef<HTMLInputElement>(null);
  // Jobs run one after another, so overlapping pastes, drops and picks land in the order they
  // came; the attach button stays busy until the last of them ends.
  const jobs = useRef<Promise<void>>(Promise.resolve());
  const pendingJobs = useRef(0);
  const [uploading, setUploading] = useState(false);
  const queuePaths = (resolve: () => Promise<string[]>): void => {
    pendingJobs.current += 1;
    setUploading(true); setNote(null);
    jobs.current = jobs.current.then(async () => {
      try {
        // the server quotes the paths for the pane's own shell, and refuses one it cannot take safely
        const text = await paneText(paneId, await resolve(), machineId);
        // an open IME syllable commits first, so the path does not land inside it; the next job
        // waits for this insert, so its path lands after this one
        await new Promise<void>((done) => commitThenLatest.current(() => { insertAtCaretLatest.current(text); done(); }));
      } catch (error) {
        setNote(error instanceof ApiError && error.code === "unsafe_path" ? t("This path cannot be typed into this pane safely")
          // a remote PC's bridge from before this route answers it as an unknown endpoint
          : error instanceof ApiError && error.code === "not_found" ? t("This PC's bridge needs an update to insert paths")
          : t("Could not attach the image. Try again."));
      } finally {
        pendingJobs.current -= 1;
        if (pendingJobs.current === 0) setUploading(false);
      }
    });
  };
  const queuePathsLatest = useRef(queuePaths);
  queuePathsLatest.current = queuePaths;
  useEffect(() => {
    if (!insertPathsRef) return;
    const handler = (paths: string[]): void => queuePathsLatest.current(async () => paths);
    insertPathsRef.current = handler;
    return () => { if (insertPathsRef.current === handler) insertPathsRef.current = null; };
  }, [insertPathsRef]);
  const attach = (files: File[], fromClipboard: boolean): void => {
    if (files.length === 0) return;
    // the server takes this many paths at once: say so before anything is uploaded
    if (files.length > MAX_INSERT_FILES) { setNote(t("Up to {n} files at a time", { n: MAX_INSERT_FILES })); return; }
    // asked now, while the clipboard still holds what was pasted; the job waits for its turn
    const original = fromClipboard && machineId === "local" ? localClipboardPaths(files) : Promise.resolve(null);
    queuePaths(async () => {
      const paths = await original;
      if (paths) return paths;
      const uploaded: string[] = [];
      for (const file of files) uploaded.push(await uploadPaneImage(paneId, file));
      return uploaded;
    });
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    // copied text, a copied path included, pastes as the box's own text
    if (event.clipboardData.getData("text/plain")) return;
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    attach(files, true);
  };
  // a dropped file carries bytes, not a path: it is saved beside the pane; dropped text stays native
  const onDragOver = (event: DragEvent<HTMLTextAreaElement>): void => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (event: DragEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    attach(files, false);
  };

  const send = useCallback(() => {
    if (!connected || terminalDraftSending(owner) || composing.current) return;
    setNote(null);
    // the stored line, not this render's: a send that waited for an IME commit runs before the re-render
    const text = readTerminalDraft(owner);
    if (text.length === 0) {
      if (!onEnter()) setNote(t("Not sent: the terminal is disconnected."));
      return;
    }
    const sent = onSend(text);
    if (sent === false) { setNote(t("Not sent: the terminal is disconnected.")); return; }
    // a polish that lands before the acknowledgement would read as text typed meanwhile, and
    // leave the sent command in the line
    dictation.forget();
    setTerminalDraftSending(owner, true);
    void sent.then((result) => {
      if (result === true) {
        // text typed while it was on its way stays
        acknowledgeTerminalDraft(owner);
      } else setNote(result);
    }).catch(() => setNote(t("Not confirmed. Check the terminal before sending again."))).finally(() => { setTerminalDraftSending(owner, false); });
  }, [connected, dictation.forget, onEnter, onSend, owner, t]);

  // A phone keyboard keeps the last syllable open, and the button keeps focus in the box, so a
  // tap on Send arrived mid-composition and was dropped. Commit the syllable first, then send.
  // The key bar's Enter waits for the same commit before it breaks the line.
  const sendLatest = useRef(send);
  sendLatest.current = send;
  const afterCommit = useRef<(() => void) | null>(null);
  const finishCommitSend = useCallback(() => {
    const action = afterCommit.current;
    if (!action) return;
    afterCommit.current = null;
    composing.current = false;
    composingCallback.current?.(false);
    setTimeout(action, 0); // after the commit's input event
  }, []);
  const commitThen = (action: () => void): void => {
    if (!composing.current) { action(); return; }
    // a path insert can be waiting on the same commit: every waiting action runs, in the order asked
    const waiting = afterCommit.current;
    afterCommit.current = waiting ? () => { waiting(); action(); } : action;
    const element = box.current;
    element?.blur(); // ends the composition: compositionend, then the committed text
    element?.focus({ preventScroll: true });
    // ponytail: a keyboard that never reports compositionend on blur goes on with what the box shows
    setTimeout(finishCommitSend, 250);
  };
  const onSendClick = (): void => commitThen(() => sendLatest.current());

  // a line break at the caret, as Shift+Enter makes: the line goes to the pane whole, breaks included
  const breakLine = (): void => {
    const element = box.current;
    if (!element) return;
    const value = readTerminalDraft(owner);
    const [start, end] = selection(value);
    const next = `${value.slice(0, start)}\n${value.slice(end)}`;
    if (next.length > TERMINAL_LINE_LIMIT) return;
    textRef.current = next;
    setText(next);
    setNote(null);
    // typing goes on on the new line: the box keeps (or takes) the keyboard
    if (document.activeElement !== element) element.focus({ preventScroll: true });
    placeCaret(element, start + 1, next.length);
  };
  const breakLineLatest = useRef(breakLine);
  breakLineLatest.current = breakLine;
  const commitThenLatest = useRef(commitThen);
  commitThenLatest.current = commitThen;
  useEffect(() => {
    if (!lineBreakRef) return;
    const handler = (): void => commitThenLatest.current(() => breakLineLatest.current());
    lineBreakRef.current = handler;
    return () => { if (lineBreakRef.current === handler) lineBreakRef.current = null; };
  }, [lineBreakRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter breaks the line; an IME keeps its Enter, including the committing
    // one WebKit can send after compositionend as key code 229
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    send();
  };

  // wrapped lines count too: a dictated sentence is one long line, and its end must stay readable
  const [wrappedRows, setWrappedRows] = useState(1);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const line = parseFloat(style.lineHeight);
    if (!(line > 0)) return;
    const shown = element.rows;
    element.rows = 1;
    const content = element.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    element.rows = shown;
    setWrappedRows(Math.max(1, Math.round(content / line)));
  }, [text]);
  const rows = Math.min(MAX_ROWS, Math.max(wrappedRows, text.split("\n").length));
  return (
    <div className={`terminal-input${dictation.shown ? " has-voice" : ""}`}>
      <textarea
        ref={box}
        className="terminal-input-text"
        rows={rows}
        value={text}
        maxLength={TERMINAL_LINE_LIMIT}
        onCompositionStart={() => { composing.current = true; onComposing?.(true); }}
        onCompositionEnd={() => { composing.current = false; onComposing?.(false); finishCommitSend(); }}
        placeholder={t("Type for the terminal…")}
        aria-label={t("Terminal input line")}
        enterKeyHint="send"
        autoCapitalize="off"
        onChange={(event) => { setText(event.target.value); setNote(null); }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onDragOver={onDragOver}
        onDrop={onDrop}
      />
      <input ref={picker} type="file" accept="image/*" multiple hidden onChange={(event) => {
        const picked = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        attach(picked, false);
      }} />
      <button type="button" className="terminal-input-attach" aria-label={t(uploading ? "Uploading file…" : "Attach image")} title={t("Attach image")}
        disabled={!connected || uploading || sending} onPointerDown={(event) => event.preventDefault()} onClick={() => picker.current?.click()}>
        <ImagePlus aria-hidden="true" />
      </button>
      {dictation.shown && <MicButton dictation={dictation} className="terminal-input-mic" />}
      <button
        type="button"
        className="terminal-input-send"
        aria-label={t(text.length === 0 ? "Press Enter in the terminal" : "Send to the terminal")}
        title={t(text.length === 0 ? "Press Enter in the terminal" : "Send to the terminal")}
        disabled={!connected || sending}
        // the soft keyboard stays up for the next line
        onPointerDown={(event) => event.preventDefault()}
        onClick={onSendClick}
      >
        {text.length === 0 ? <CornerDownLeft aria-hidden="true" /> : <SendHorizontal aria-hidden="true" />}
      </button>
      {note !== null && <p className="terminal-input-note" role="alert">{note}</p>}
      {dictation.shown && <VoiceRecordingPill dictation={dictation} align="end" />}
    </div>
  );
}
