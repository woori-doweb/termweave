/**
 * The agent map: PC → project (workspace) → P-number → agent, every agent pane included.
 * Each project is one row: its node on the left, a curve to each of its panes on the right.
 * Pane rows have a fixed height (ROW, in FleetPanel.css too), so the curves need no measuring.
 */
import type { Machine } from "../../shared/machines.ts";
import { buildFleetMap, type FleetMapMachine, type FleetMapState } from "../lib/fleetMap.ts";
import { t } from "../lib/i18n.ts";
import { AgentMark } from "./AgentMark.tsx";

const ROW = 34;
const LINK = 36;
const STATE: Readonly<Record<FleetMapState, string>> = { running: "Running", attention: "Needs you", reported: "Done", idle: "Idle" };

interface Props {
  readonly machines: ReadonlyArray<Machine>;
  readonly onOpen: (machineId: string, paneId: string) => void;
}

export function FleetMap({ machines, onOpen }: Props) {
  const map = buildFleetMap(machines);
  const agents = map.reduce((sum, machine) => sum + machine.projects.reduce((n, project) => n + project.panes.length, 0), 0);
  if (agents === 0) return null;
  const projects = map.reduce((sum, machine) => sum + machine.projects.length, 0);
  return (
    <section aria-labelledby="fleet-map-title" className="fleet-map">
      <div className="fleet-map-head">
        <h3 id="fleet-map-title">{t("Agent map")}</h3>
        <span>{t("{agents} agents in {projects} projects", { agents, projects })}</span>
      </div>
      {map.map((machine) => <FleetMapPc key={machine.id} machine={machine} onOpen={onOpen} />)}
    </section>
  );
}

function FleetMapPc({ machine, onOpen }: { readonly machine: FleetMapMachine; readonly onOpen: Props["onOpen"] }) {
  return (
    <div className="fleet-map-pc">
      <span className="fleet-map-pc-name">{machine.label}</span>
      {machine.projects.map((project) => {
        const height = project.panes.length * ROW;
        return (
          <div key={project.key} className="fleet-map-project">
            <div className="fleet-map-node">
              <span className="fleet-map-node-number">{project.number}</span>
              <span className="fleet-map-node-label">{project.label}</span>
              <small>{t("{n} agents", { n: project.panes.length })}</small>
            </div>
            <svg aria-hidden="true" className="fleet-map-links" width={LINK} height={height} viewBox={`0 0 ${LINK} ${height}`} preserveAspectRatio="none">
              {project.panes.map((pane, index) => {
                const y = index * ROW + ROW / 2;
                return <path key={pane.key} data-state={pane.state} d={`M0 ${height / 2} C${LINK / 2} ${height / 2} ${LINK / 2} ${y} ${LINK} ${y}`} />;
              })}
            </svg>
            <ul className="fleet-map-panes">
              {project.panes.map((pane) => (
                <li key={pane.key}>
                  <button type="button" className="fleet-map-pane" data-state={pane.state} onClick={() => onOpen(machine.id, pane.paneId)} title={[pane.number, pane.agentLabel, pane.title, t(STATE[pane.state])].filter(Boolean).join(" · ")}>
                    <span aria-hidden="true" className="fleet-state-dot" data-state={pane.state} />
                    <span className="fleet-map-pane-number">{pane.number}</span>
                    <span className="fleet-map-pane-agent"><AgentMark agent={pane.agent} size={14} />{pane.agentLabel}</span>
                    <span className="fleet-map-pane-title">{pane.title}</span>
                    {pane.subagents > 0 ? <span className="fleet-map-pane-sub">+{pane.subagents === 1 ? t("1 subagent") : t("{n} subagents", { n: pane.subagents })}</span> : null}
                    <span className="fleet-map-pane-state">{t(STATE[pane.state])}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
