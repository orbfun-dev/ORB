import { FlaskConical, X } from "lucide-react";
import { buildFixtureSnapshot, FIXTURE_SCENARIO_NAMES } from "./fixtures";
import { useRoundData } from "../context/RoundDataProvider";

/**
 * Development-only fixture switcher, rendered while fixture mode is
 * active (`?fixture=<name>`). Scenario descriptions come from the same
 * builders the reducer loads, so the label always matches the state tree.
 */
export function FixtureBar() {
  const { state, loadFixture } = useRoundData();
  if (state.mode !== "fixture") return null;

  const snapshot = state.fixtureName !== null ? buildFixtureSnapshot(state.fixtureName) : null;

  return (
    // Dev-only chrome, deliberately marked in the one hue the production
    // palette never uses for state — nobody should mistake a fixture
    // render for a live round.
    <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-orbit-violet/40 bg-orbit-violet/[0.07] px-4 py-2.5 text-xs">
      <span className="flex items-center gap-1.5 font-bold uppercase tracking-[0.14em] text-orbit-violet">
        <FlaskConical className="size-3.5" /> FIXTURE MODE
      </span>
      <label className="flex items-center gap-1.5 text-orbit-muted">
        scenario
        <select
          className="rounded-md border border-orbit-line bg-orbit-panel-2 px-2 py-1 font-medium text-orbit-text"
          value={state.fixtureName ?? ""}
          onChange={(e) => loadFixture(e.target.value)}
        >
          {FIXTURE_SCENARIO_NAMES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {snapshot !== null && (
        <span className="text-orbit-muted">{snapshot.description}</span>
      )}
      <a
        href={typeof window === "undefined" ? "/" : window.location.pathname}
        className="pressable ml-auto flex items-center gap-1 rounded-md border border-orbit-line px-2 py-1 font-semibold text-orbit-muted hover:border-orbit-line-2 hover:text-orbit-text"
      >
        <X className="size-3" /> go live
      </a>
    </div>
  );
}
