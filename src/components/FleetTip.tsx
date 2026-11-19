import { useId, useRef, type ReactNode } from "react";

const GAP = 6;
const EDGE = 8;

/** Places an open popover above its trigger (below when the top would cut it), inside the window. */
export function placeNear(popover: HTMLElement, trigger: HTMLElement): void {
  const rect = trigger.getBoundingClientRect();
  const above = rect.top - popover.offsetHeight - GAP;
  popover.style.top = `${above >= EDGE ? above : rect.bottom + GAP}px`;
  popover.style.left = `${Math.min(Math.max(EDGE, rect.left + rect.width / 2 - popover.offsetWidth / 2), window.innerWidth - popover.offsetWidth - EDGE)}px`;
}

/**
 * GOAT's Tooltip for the Fleet page, on the platform's Popover API: the tip opens in the top
 * layer (above the Fleet dialog and outside any clipping box) on hover, focus or tap, closes on
 * leave, blur or Escape, and the trigger names it with aria-describedby.
 */
export function FleetTip(props: {
  readonly tip: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  /** the trigger's accessible name, when its text alone does not say enough */
  readonly label?: string;
  /** a button (a count chip) rather than focusable text */
  readonly button?: boolean;
  readonly onClick?: () => void;
}) {
  const id = useId();
  const tip = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const show = () => {
    const popover = tip.current;
    const trigger = anchor.current;
    if (popover === null || trigger === null) return;
    try { if (!popover.matches(":popover-open")) popover.showPopover(); } catch { return; }
    placeNear(popover, trigger);
  };
  const hide = () => { try { tip.current?.hidePopover(); } catch { /* already closed */ } };
  const common = {
    "aria-describedby": id, "aria-label": props.label, className: props.className,
    onPointerEnter: show, onPointerLeave: hide, onFocus: show, onBlur: hide,
    onKeyDown: (event: { key: string }) => { if (event.key === "Escape") hide(); },
  };
  return (
    <>
      {props.button
        ? <button type="button" ref={(node) => { anchor.current = node; }} {...common} onClick={props.onClick}>{props.children}</button>
        : <span tabIndex={0} ref={(node) => { anchor.current = node; }} {...common}>{props.children}</span>}
      <div ref={tip} id={id} popover="manual" role="tooltip" className="fleet-tip">{props.tip}</div>
    </>
  );
}
