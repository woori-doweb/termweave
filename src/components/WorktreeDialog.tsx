import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorktreeCreated } from "../../shared/protocol.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import "./RenamePaneButton.css";

/** herdr checks out a new branch from the pane's folder and opens a shell there as a workspace of its own. */
export function WorktreeDialog({pane,onCreated,onClose}: {
  pane: {pane_id: string}; onCreated: (created: WorktreeCreated) => void | Promise<void>; onClose: () => void;
}) {
  const t=useT();const id=useId();const dialog=useRef<HTMLDialogElement>(null);const {createWorktreePane}=useMachineApi();
  const [branch,setBranch]=useState("");const [base,setBase]=useState("");
  const [pending,setPending]=useState(false);const [error,setError]=useState("");
  useEffect(()=>{dialog.current?.showModal();},[]);
  const create=async()=>{
    if(!branch.trim()||pending)return;setPending(true);setError("");
    try{
      const created=await createWorktreePane({pane_id:pane.pane_id,branch:branch.trim(),base:base.trim()||null});
      await onCreated(created);dialog.current?.close();onClose();
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setPending(false);}
  };
  return createPortal(<dialog ref={dialog} className="modal rename-terminal-dialog worktree-dialog" aria-labelledby={id}
    onCancel={event=>{if(pending)event.preventDefault();}} onClose={()=>{if(!pending)onClose();}}>
    <form onSubmit={event=>{event.preventDefault();void create();}}>
      <header className="modal-header"><h2 className="modal-title" id={id}>{t("New terminal in worktree")}</h2></header>
      <div className="modal-body">
        <label className="field"><span className="field-label">{t("Branch name")}</span><input className="input" autoFocus required maxLength={200}
          disabled={pending} value={branch} onChange={event=>setBranch(event.target.value)}/></label>
        <label className="field"><span className="field-label">{t("Base (optional)")}</span><input className="input" maxLength={200}
          disabled={pending} placeholder={t("Current branch")} value={base} onChange={event=>setBase(event.target.value)}/></label>
        <p className="field-hint">{t("Creates a git worktree from this terminal's folder and opens a shell there as a new workspace. Untracked files such as node_modules or .env are not copied.")}</p>
        {error&&<p role="alert" className="confirm-error">{error}</p>}</div>
      <footer className="modal-footer"><button className="btn" type="button" disabled={pending} onClick={()=>{dialog.current?.close();onClose();}}>{t("Cancel")}</button>
        <button className="btn" type="submit" disabled={pending||!branch.trim()}>{t("Create")}</button></footer>
    </form>
  </dialog>,document.body);
}
