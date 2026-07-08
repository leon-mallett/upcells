import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { listen } from "@tauri-apps/api/event";
import {
  Sparkles,
  Send,
  Loader2,
  ChevronDown,
  ChevronRight,
  Lock,
  Cpu,
  Database,
  FileBarChart,
  X,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  useActiveAiModel,
  useAskDataPool,
  useDataPools,
  useGenerateReport,
} from "@/hooks/useAssistant";
import { useSalesAccelerator } from "@/hooks/useLicense";
import ProspectingPanel from "@/components/assistant/ProspectingPanel";
import CoachPanel from "@/components/assistant/CoachPanel";
import type { PoolAnswer, Report, ReportProgress } from "@/lib/tauri-commands";

type QaTurn = { kind: "qa"; question: string; answer: PoolAnswer | null };
type ReportTurn = { kind: "report"; prompt: string; report: Report | null };
type Turn = QaTurn | ReportTurn;

/** Question idea shortcuts. `query` prefills the box; `soon` are roadmap placeholders. */
const IDEAS: { label: string; kind: "query" | "soon"; text?: string }[] = [
  {
    label: "My 3 largest open opportunities",
    kind: "query",
    text: "What are my 3 largest open opportunities?",
  },
  { label: "Total amount by stage", kind: "query", text: "What is the total amount by stage?" },
  {
    label: "Accounts with the most opportunities",
    kind: "query",
    text: "Which accounts have the most opportunities?",
  },
];

const REPORT_TEMPLATES: { id: string; label: string }[] = [
  { id: "pipeline_summary", label: "Pipeline summary" },
  { id: "activity_report", label: "Activity report" },
  { id: "win_loss", label: "Win/loss" },
];

export default function AssistantPage() {
  const entitled = useSalesAccelerator();
  return entitled ? <AssistantFeature /> : <AssistantUpsell />;
}

function AssistantFeature() {
  const activeModel = useActiveAiModel();
  const pools = useDataPools();
  const ask = useAskDataPool();
  const report = useGenerateReport();

  const poolList = useMemo(() => pools.data ?? [], [pools.data]);
  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [reportMode, setReportMode] = useState(false);
  const [reportStep, setReportStep] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "prospecting" | "coaching">("chat");

  const modelReady = !!activeModel.data;
  const busy = ask.isPending || report.isPending;

  useEffect(() => {
    if (!selectedPoolId && poolList.length) setSelectedPoolId(poolList[0].id);
  }, [poolList, selectedPoolId]);

  async function sendQuestion(text: string) {
    const q = text.trim();
    if (!q || !selectedPoolId || !modelReady || busy) return;
    setQuestion("");
    const history = turns
      .filter((t): t is QaTurn => t.kind === "qa" && t.answer !== null)
      .map((t) => ({ question: t.question, sql: t.answer!.sql }));
    const res = await ask
      .mutateAsync({ pool_id: selectedPoolId, question: q, history })
      .catch(() => null);
    setTurns((t) => [...t, { kind: "qa", question: q, answer: res }]);
  }

  async function runReport(opts: { template?: string; request?: string; label: string }) {
    if (!selectedPoolId || !modelReady || busy) return;
    setReportStep("Starting…");
    const unlisten = await listen<ReportProgress>("report:progress", (e) =>
      setReportStep(e.payload.step),
    );
    try {
      const res = await report
        .mutateAsync({ pool_id: selectedPoolId, template: opts.template, request: opts.request })
        .catch(() => null);
      setTurns((t) => [...t, { kind: "report", prompt: opts.label, report: res }]);
    } finally {
      unlisten();
      setReportStep(null);
    }
  }

  function onSend() {
    const text = question.trim();
    if (!text) return;
    if (reportMode) {
      setQuestion("");
      setReportMode(false);
      runReport({ request: text, label: text });
    } else {
      sendQuestion(text);
    }
  }

  const canSend = !!modelReady && !!selectedPoolId && !!question.trim() && !busy;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-4 p-6">
        <header>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Sparkles className="h-6 w-6 text-primary" /> Sales Accelerator
          </h1>
          <p className="text-sm text-muted-foreground">
            Ask questions and generate reports from your sales data — runs 100% on your machine.
          </p>
        </header>

        {modelReady && (
          <div className="flex gap-1 border-b pb-1.5">
            <ViewTab active={view === "chat"} onClick={() => setView("chat")} label="Ask & report" />
            <ViewTab
              active={view === "prospecting"}
              onClick={() => setView("prospecting")}
              label="Prospecting"
            />
            <ViewTab
              active={view === "coaching"}
              onClick={() => setView("coaching")}
              label="Coach"
            />
          </div>
        )}

        {!modelReady ? (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Cpu className="h-4 w-4" /> Set up your AI model
              </CardTitle>
              <CardDescription>
                Choose and download a local AI model to power the Accelerator.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link to="/settings">
                <Button size="sm">Open Settings</Button>
              </Link>
            </CardContent>
          </Card>
        ) : view === "prospecting" ? (
          <div className="flex-1">
            <ProspectingPanel />
          </div>
        ) : view === "coaching" ? (
          <CoachPanel />
        ) : poolList.length === 0 ? (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Database className="h-4 w-4" /> Add some data
              </CardTitle>
              <CardDescription>
                In Sales Data, run a query and choose "Save as Data Pool" (or import a file), then
                come back to ask questions about it.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link to="/data" search={{}}>
                <Button size="sm">Go to Sales Data</Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="flex-1 space-y-4">
              {turns.length === 0 ? (
                <div className="space-y-3 pt-2">
                  <p className="text-sm text-muted-foreground">Try asking…</p>
                  <div className="flex flex-wrap gap-2">
                    {IDEAS.map((idea) => (
                      <button
                        key={idea.label}
                        onClick={() =>
                          idea.kind === "query"
                            ? setQuestion(idea.text!)
                            : toast("Coming soon — this is on the roadmap.")
                        }
                        className={cn(
                          "rounded-full border px-3 py-1.5 text-xs transition hover:bg-accent",
                          idea.kind === "soon" && "text-muted-foreground",
                        )}
                      >
                        {idea.label}
                        {idea.kind === "soon" && (
                          <span className="ml-1.5 text-[10px] opacity-60">soon</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                turns.map((turn, i) => <TurnView key={i} turn={turn} />)
              )}
              {ask.isPending && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
                </div>
              )}
              {report.isPending && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Generating report
                  {reportStep ? ` — ${reportStep}` : "…"}
                </div>
              )}
            </div>

            <div className="sticky bottom-0 space-y-2 bg-background pt-2">
              {/* Reports bar / custom-report indicator */}
              {reportMode ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <FileBarChart className="h-3.5 w-3.5" />
                  Report mode — describe the report you want.
                  <button
                    onClick={() => setReportMode(false)}
                    className="flex items-center gap-0.5 hover:text-foreground"
                  >
                    <X className="h-3 w-3" /> cancel
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <FileBarChart className="h-3.5 w-3.5" /> Reports:
                  </span>
                  {REPORT_TEMPLATES.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => runReport({ template: t.id, label: t.label })}
                      disabled={busy}
                      className="rounded-full border px-2.5 py-1 text-xs transition hover:bg-accent disabled:opacity-50"
                    >
                      {t.label}
                    </button>
                  ))}
                  <button
                    onClick={() => setReportMode(true)}
                    disabled={busy}
                    className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-accent disabled:opacity-50"
                  >
                    Custom…
                  </button>
                </div>
              )}

              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground">Data:</label>
                <select
                  value={selectedPoolId ?? ""}
                  onChange={(e) => {
                    setSelectedPoolId(e.target.value);
                    setTurns([]);
                  }}
                  className="rounded-md border bg-background px-2 py-1 text-xs"
                >
                  {poolList.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {turns.length > 0 && (
                  <button
                    onClick={() => setTurns([])}
                    className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                  >
                    New chat
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <Input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canSend) onSend();
                  }}
                  placeholder={
                    reportMode ? "Describe the report you want…" : "Ask about your data…"
                  }
                />
                <Button onClick={onSend} disabled={!canSend}>
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ViewTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50",
      )}
    >
      {label}
    </button>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  return turn.kind === "qa" ? <QaView turn={turn} /> : <ReportView turn={turn} />;
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl bg-primary px-4 py-2 text-sm text-primary-foreground">
        {text}
      </div>
    </div>
  );
}

function QaView({ turn }: { turn: QaTurn }) {
  const [showSql, setShowSql] = useState(false);
  return (
    <div className="space-y-2">
      <UserBubble text={turn.question} />
      {turn.answer ? (
        <div className="space-y-2">
          <div className="max-w-[90%] rounded-2xl border bg-muted/30 px-4 py-2 text-sm leading-relaxed">
            {turn.answer.answer}
          </div>
          <button
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowSql((s) => !s)}
          >
            {showSql ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            Show the query &amp; data
          </button>
          {showSql && (
            <div className="space-y-2">
              <SqlBlock sql={turn.answer.sql} />
              <ResultTable
                columns={turn.answer.columns}
                rows={turn.answer.rows}
                truncated={turn.answer.truncated}
              />
            </div>
          )}
        </div>
      ) : (
        <ErrorBubble text="Sorry, I couldn't answer that one. Try rephrasing the question." />
      )}
    </div>
  );
}

function ReportView({ turn }: { turn: ReportTurn }) {
  const [showFigures, setShowFigures] = useState(false);
  const r = turn.report;
  return (
    <div className="space-y-2">
      <UserBubble text={turn.prompt} />
      {r ? (
        <div className="space-y-3 rounded-2xl border bg-muted/30 p-4">
          <h3 className="text-base font-semibold">{r.title}</h3>
          <div className="whitespace-pre-wrap text-sm leading-relaxed">{r.narrative}</div>
          <button
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowFigures((s) => !s)}
          >
            {showFigures ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            Figures &amp; queries ({r.metrics.length})
          </button>
          {showFigures && (
            <div className="space-y-3">
              {r.metrics.map((m, i) => (
                <div key={i} className="space-y-1.5">
                  <p className="text-xs font-medium">{m.question}</p>
                  <SqlBlock sql={m.sql} />
                  <ResultTable columns={m.columns} rows={m.rows} truncated={false} />
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <ErrorBubble text="Sorry, I couldn't generate that report. The data may not fit it." />
      )}
    </div>
  );
}

function ErrorBubble({ text }: { text: string }) {
  return (
    <div className="max-w-[90%] rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive">
      {text}
    </div>
  );
}

function SqlBlock({ sql }: { sql: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
      <code>{sql}</code>
    </pre>
  );
}

function AssistantUpsell() {
  return (
    <div className="mx-auto max-w-2xl p-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="h-4 w-4" /> Sales Accelerator
          </CardTitle>
          <CardDescription>A premium add-on for Upcells.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Ask questions and generate reports from your Salesforce data in plain English, with a
            private AI assistant that runs entirely on your machine — no data ever leaves your
            device.
          </p>
          <p>
            Your current licence doesn't include this tier. Contact us to upgrade and unlock the
            Accelerator.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function ResultTable({
  columns,
  rows,
  truncated,
}: {
  columns: string[];
  rows: string[][];
  truncated: boolean;
}) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No rows returned.</p>;
  }
  const shown = rows.slice(0, 100);
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-xs">
        <thead className="bg-muted/50">
          <tr>
            {columns.map((c) => (
              <th key={c} className="px-3 py-1.5 text-left font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i} className="border-t">
              {r.map((cell, j) => (
                <td key={j} className="px-3 py-1.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(truncated || rows.length > shown.length) && (
        <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          Showing first {shown.length} rows{truncated ? " (result truncated at 1000)" : ""}.
        </div>
      )}
    </div>
  );
}
