/**
 * S9.12-002 — DevTools pane (raw snapshot mirror + property catalog +
 * hidden command map + raw command form).
 *
 * Views:
 *   - Raw: collapsible JSON viewer of the snapshot's `raw` mirror (9.9-002).
 *   - Catalog: searchable table of `printer_property_catalog` fixtures.
 *   - Commands: searchable table of `printer_hidden_command_map` fixtures
 *     with per-row safety badges.
 *   - Raw send: a `printer_command_send` form that is GATED — the user must
 *     type the exact confirmation word (`EXECUTE`) before send enables, and
 *     the capability policy (raw.command: agentBlocked) blocks the Agent
 *     from ever reaching this lane (9.10-001).
 *
 * Audit: every DevTools action (open, search, send attempt / accepted /
 * failed) is appended to the session journal store (`useDevtoolsJournal`).
 *
 * The UI is always the USER actor — the Agent gate is enforced by
 * `allowedFor("agent", …) === false` (unit-tested) and by the printer
 * bridge lane never trusting callers.
 */

import { useMemo, useState } from "react";
import { useI18n } from "@/state/i18n";
import { useUi } from "@/state/ui";
import { useDevtoolsJournal } from "@/state/devtools-journal";
import { searchCatalog, searchCommands, validateRawCommand } from "@/state/devtools-core";
import { allowedFor, entryFor, CAPABILITY_SURFACE } from "@/state/capability-surface";
import type { DevtoolsReadModel } from "@/bridge/types";
import type { RawCommandRequest } from "@/bridge/types";
import type { MsgKey } from "@/state/i18n-core";

interface DevToolsPaneProps {
  readonly raw: Readonly<Record<string, unknown>>;
}

type View = "raw" | "catalog" | "commands";

/** i18n keys per safety class (badge color). */
const SAFETY_LABEL: Record<DevtoolsReadModel["commands"][number]["safety"], MsgKey> = {
  read: "devtools.safety.read",
  state: "devtools.safety.state",
  thermal: "devtools.safety.thermal",
  motion: "devtools.safety.motion",
  job: "devtools.safety.job",
};

export function DevToolsPane({ raw }: DevToolsPaneProps) {
  const t = useI18n((s) => s.t);
  const pushToast = useUi((s) => s.pushToast);
  const log = useDevtoolsJournal((s) => s.log);
  const clear = useDevtoolsJournal((s) => s.clear);
  const entries = useDevtoolsJournal((s) => s.entries);

  const [view, setView] = useState<View>("raw");
  const [rawOpen, setRawOpen] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [commandQuery, setCommandQuery] = useState("");
  const [model, setModel] = useState<DevtoolsReadModel | null>(null);
  const [cmdName, setCmdName] = useState("");
  const [argsText, setArgsText] = useState("");
  const [confirmWord, setConfirmWord] = useState("");
  const [busy, setBusy] = useState(false);

  const rawEntry = entryFor(CAPABILITY_SURFACE, "raw.command");
  // The pane is the USER side — the Agent is structurally blocked.
  const rawAllowed = rawEntry ? allowedFor("user", rawEntry) : false;

  // First open of catalog/commands triggers the read-only model lane and
  // journal the load.
  const ensureModel = async () => {
    if (model) return;
    const lane = await import("@/bridge/mock");
    const handle = await lane.fetchSceneSnapshot();
    const loaded = await handle.devtoolsReadModel();
    setModel(loaded);
    log(
      "devtools.open",
      `readModel catalog=${loaded.catalog.length} commands=${loaded.commands.length}`,
    );
  };

  const catalogRows = useMemo(
    () => searchCatalog(model?.catalog ?? [], catalogQuery),
    [model, catalogQuery],
  );
  const commandRows = useMemo(
    () => searchCommands(model?.commands ?? [], commandQuery),
    [model, commandQuery],
  );

  const setViewForever = (next: View) => {
    setView(next);
    if (next === "catalog" || next === "commands") {
      void ensureModel().catch(() =>
        pushToast({ kind: "warning", title: "DevTools", message: t("devtools.rawEmpty") }),
      );
    }
  };

  const argsParsed = useMemo<Record<string, string | number | boolean> | null>(() => {
    if (!argsText.trim()) return {};
    try {
      const parsed = JSON.parse(argsText) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
      return parsed as Record<string, string | number | boolean>;
    } catch {
      return null;
    }
  }, [argsText]);

  const validation = argsParsed === null ? "JSON" : validateRawCommand(cmdName, argsParsed);
  const confirmOk = confirmWord === "EXECUTE";
  const canSend = rawAllowed && confirmOk && validation === null && !busy;

  const onSendRaw = async () => {
    if (!canSend || argsParsed === null || !rawEntry) return;
    setBusy(true);
    log("devtools.raw.request", `raw ${cmdName}`);
    try {
      const request: RawCommandRequest = { command: cmdName, args: argsParsed };
      const lane = await import("@/bridge/mock");
      const handle = await lane.fetchSceneSnapshot();
      const result = await handle.rawCommand(request);
      if (result.ok) {
        log("devtools.raw.accepted", `raw ${result.command}`);
        pushToast({ kind: "success", title: t("devtools.accepted"), message: result.command });
      } else {
        log("devtools.raw.failed", `raw ${request.command} — ${result.error} (${result.kind})`);
        pushToast({ kind: "error", title: t("devtools.failed"), message: result.error });
      }
    } catch (error) {
      log("devtools.raw.failed", `raw ${cmdName} — ${String(error)}`);
      pushToast({ kind: "error", title: t("devtools.failed"), message: String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="devtools-pane" data-testid="devtools-pane">
      <header className="device-section-title">{t("devtools.title")}</header>
      <div className="devtools-tabs" role="tablist">
        <button
          type="button"
          className={`devtools-tab${view === "raw" ? " is-active" : ""}`}
          data-testid="devtools-view-raw"
          onClick={() => setViewForever("raw")}
        >
          {t("devtools.raw")}
        </button>
        <button
          type="button"
          className={`devtools-tab${view === "catalog" ? " is-active" : ""}`}
          data-testid="devtools-view-catalog"
          onClick={() => setViewForever("catalog")}
        >
          {t("devtools.catalog")}
        </button>
        <button
          type="button"
          className={`devtools-tab${view === "commands" ? " is-active" : ""}`}
          data-testid="devtools-view-commands"
          onClick={() => setViewForever("commands")}
        >
          {t("devtools.commands")}
        </button>
      </div>

      {view === "raw" ? (
        <section className="devtools-section" data-testid="devtools-section-raw">
          <button
            type="button"
            className="devtools-raw-toggle"
            data-testid="devtools-raw-toggle"
            onClick={() => {
              log("devtools.rawView", rawOpen ? "collapse" : "expand");
              setRawOpen((o) => !o);
            }}
          >
            {t("devtools.raw")} — {rawOpen ? "▾" : "▸"}
          </button>
          {rawOpen ? (
            <pre className="devtools-json" data-testid="devtools-raw-json">
              {Object.keys(raw).length ? JSON.stringify(raw, null, 2) : t("devtools.rawEmpty")}
            </pre>
          ) : null}
        </section>
      ) : null}

      {view === "catalog" ? (
        <section className="devtools-section" data-testid="devtools-section-catalog">
          <input
            className="devtools-search"
            data-testid="devtools-catalog-search"
            placeholder={t("devtools.catalogSearch")}
            value={catalogQuery}
            onChange={(e) => {
              setCatalogQuery(e.target.value);
              log("devtools.catalog.search", `q="${e.target.value}"`);
            }}
          />
          <div className="devtools-table-wrap">
            <table className="devtools-table">
              <thead>
                <tr>
                  <th>{t("devtools.row.source")}</th>
                  <th>{t("devtools.row.path")}</th>
                  <th>{t("devtools.row.type")}</th>
                  <th>{t("devtools.row.unit")}</th>
                  <th>{t("devtools.row.group")}</th>
                </tr>
              </thead>
              <tbody>
                {catalogRows.map((row, i) => (
                  <tr key={`${row.source}.${row.path}.${i}`} data-testid="devtools-catalog-row">
                    <td className="mono-num">{row.source}</td>
                    <td className="mono-num">{row.path}</td>
                    <td>{row.type}</td>
                    <td>{row.unit ?? "—"}</td>
                    <td>{row.group}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {view === "commands" ? (
        <section className="devtools-section" data-testid="devtools-section-commands">
          <input
            className="devtools-search"
            data-testid="devtools-commands-search"
            placeholder={t("devtools.commandsSearch")}
            value={commandQuery}
            onChange={(e) => {
              setCommandQuery(e.target.value);
              log("devtools.commands.search", `q="${e.target.value}"`);
            }}
          />
          <div className="devtools-table-wrap">
            <table className="devtools-table">
              <thead>
                <tr>
                  <th>{t("devtools.row.type")}</th>
                  <th>{t("devtools.row.path")}</th>
                  <th>{t("devtools.row.safety")}</th>
                  <th>{t("devtools.row.evidence")}</th>
                  <th>{t("devtools.row.note")}</th>
                </tr>
              </thead>
              <tbody>
                {commandRows.map((row, i) => (
                  <tr key={`${row.type}.${row.action}.${i}`} data-testid="devtools-command-row">
                    <td className="mono-num">{row.type}</td>
                    <td className="mono-num">{row.action}</td>
                    <td>
                      <span
                        className={`devtools-safety devtools-safety-${row.safety}`}
                        data-testid="devtools-safety-badge"
                      >
                        {t(SAFETY_LABEL[row.safety])}
                      </span>
                    </td>
                    <td>{row.evidence}</td>
                    <td>{row.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="devtools-rawsend" data-testid="devtools-rawsend">
            <header className="devtools-rawsend-title">{t("devtools.rawSend")}</header>
            {!rawAllowed ? (
              <div className="devtools-blocked" data-testid="devtools-raw-blocked">
                {t("devtools.rawBlockedAgent")}
              </div>
            ) : (
              <>
                <label className="devtools-field">
                  <span>{t("devtools.rawCommand")}</span>
                  <input
                    className="devtools-input mono-num"
                    data-testid="devtools-raw-command"
                    value={cmdName}
                    placeholder="light"
                    onChange={(e) => setCmdName(e.target.value)}
                  />
                </label>
                <label className="devtools-field">
                  <span>{t("devtools.rawArgs")}</span>
                  <textarea
                    className="devtools-input devtools-args mono-num"
                    data-testid="devtools-raw-args"
                    value={argsText}
                    rows={3}
                    placeholder='{"status": 1}'
                    onChange={(e) => setArgsText(e.target.value)}
                  />
                </label>
                {argsParsed === null && argsText.trim() ? (
                  <div
                    className="devtools-hint devtools-hint-error"
                    data-testid="devtools-raw-json-error"
                  >
                    {t("devtools.rawConfirmMismatch")}
                  </div>
                ) : null}
                <label className="devtools-field">
                  <span>{t("devtools.rawConfirmWord")}</span>
                  <input
                    className="devtools-input mono-num"
                    data-testid="devtools-raw-confirm"
                    value={confirmWord}
                    placeholder="EXECUTE"
                    onChange={(e) => setConfirmWord(e.target.value)}
                  />
                </label>
                <div className="devtools-hint">{t("devtools.rawConfirmHint")}</div>
                <button
                  type="button"
                  className="devtools-send"
                  data-testid="devtools-raw-send"
                  disabled={!canSend}
                  onClick={() => void onSendRaw()}
                >
                  {busy ? "…" : "EXECUTE"}
                </button>
              </>
            )}
          </div>
        </section>
      ) : null}

      <section className="devtools-section" data-testid="devtools-journal">
        <header className="devtools-journal-head">
          <span>{t("devtools.journal.title")}</span>
          <button
            type="button"
            className="devtools-journal-clear"
            data-testid="devtools-journal-clear"
            onClick={() => {
              clear();
              log("devtools.open", "journal cleared");
            }}
          >
            {t("devtools.journal.clear")}
          </button>
        </header>
        {entries.length === 0 ? (
          <div className="devtools-journal-empty">{t("devtools.journal.empty")}</div>
        ) : (
          <ul className="devtools-journal-list" data-testid="devtools-journal-list">
            {[...entries].reverse().map((e) => (
              <li key={e.id} className="devtools-journal-item mono-num" data-kind={e.kind}>
                #{e.id} {new Date(e.at).toLocaleTimeString()} {e.kind} {e.detail}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
