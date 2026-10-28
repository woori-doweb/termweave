import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorktreeCreated, WorktreeSource } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { paneNumber } from "../lib/paneNumber.ts";
import { useT } from "../lib/i18n.ts";
import "./RenamePaneButton.css";

/**
 * herdr checks out a new branch from the repo of the pane's folder and opens a shell there as a
 * workspace of its own; the base starts as the branch (or the commit) the pane's checkout is on.
 */
export function WorktreeDialog({pane,onCreated,onClose}: {
  pane: {pane_id: string; global_pane_number?: number; label?: string | null};
  onCreated: (created: WorktreeCreated) => void | Promise<void>; onClose: () => void;
}) {
  const t=useT();const id=useId();const dialog=useRef<HTMLDialogElement>(null);const {fetchWorktreeSource,createWorktreePane}=useMachineApi();
  const [branch,setBranch]=useState("");const [base,setBase]=useState("");
  const [source,setSource]=useState<WorktreeSource|null>(null);const [reading,setReading]=useState(true);const [notRepo,setNotRepo]=useState(false);
  const [pending,setPending]=useState(false);const [error,setError]=useState("");
  useEffect(()=>{dialog.current?.showModal();},[]);
  useEffect(()=>{
    let live=true;
    fetchWorktreeSource(pane.pane_id).then(found=>{if(!live)return;setSource(found);setBase(found.branch??found.head);},
      (e:unknown)=>{
        if(!live)return;
        if(e instanceof ApiError&&e.code==="not_a_git_repository")setNotRepo(true);
        else setError(e instanceof Error?e.message:String(e));
      }).finally(()=>{if(live)setReading(false);});
    return()=>{live=false;};
  },[fetchWorktreeSource,pane.pane_id]);
  const blocked=pending||reading||notRepo;
  const create=async()=>{
    if(!branch.trim()||blocked)return;setPending(true);setError("");
    try{
      const created=await createWorktreePane({pane_id:pane.pane_id,branch:branch.trim(),base:base.trim()||null});
      await onCreated(created);dialog.current?.close();onClose();
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setPending(false);}
  };
  const paneName=pane.label?`${paneNumber(pane)} · ${pane.label}`:paneNumber(pane);
  return createPortal(<dialog ref={dialog} className="modal rename-terminal-dialog worktree-dialog" aria-labelledby={id}
    onCancel={event=>{if(pending)event.preventDefault();}} onClose={()=>{if(!pending)onClose();}}>
    <form onSubmit={event=>{event.preventDefault();void create();}}>
      <header className="modal-header"><h2 className="modal-title" id={id}>{t("New terminal in worktree")}</h2></header>
      <div className="modal-body">
        {reading&&<p className="field-hint" role="status">{t("Reading the terminal's branch…")}</p>}
        {source&&<div className="field-hint">
          <div>{t("From terminal {pane}",{pane:paneName})}</div>
          <div>{t("Folder {path}",{path:source.cwd})}</div>
          <div>{source.branch===null?t("Detached at {head}",{head:source.head}):t("Current branch {branch} ({head})",{branch:source.branch,head:source.head})}</div>
          {source.linked&&<div>{t("This terminal is in a worktree of {repo}: the new worktree is made from the repo, based on {branch}.",{repo:source.repo_name,branch:source.branch??source.head})}</div>}
        </div>}
        <label className="field"><span className="field-label">{t("Branch name")}</span><input className="input" autoFocus required maxLength={200}
          disabled={pending} value={branch} onChange={event=>setBranch(event.target.value)}/></label>
        <label className="field"><span className="field-label">{t("Base (optional)")}</span><input className="input" maxLength={200}
          disabled={pending||reading} placeholder={t("Current branch")} value={base} onChange={event=>setBase(event.target.value)}/></label>
        <p className="field-hint">{t("Creates a git worktree from this terminal's folder and opens a shell there as a new workspace. Untracked files such as node_modules or .env are not copied.")}</p>
        {(notRepo||error)&&<p role="alert" className="confirm-error">{notRepo?t("This terminal's folder is not in a git repository."):error}</p>}</div>
      <footer className="modal-footer"><button className="btn" type="button" disabled={pending} onClick={()=>{dialog.current?.close();onClose();}}>{t("Cancel")}</button>
        <button className="btn" type="submit" disabled={blocked||!branch.trim()}>{t("Create")}</button></footer>
    </form>
  </dialog>,document.body);
}
