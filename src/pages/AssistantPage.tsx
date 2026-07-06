import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Sparkles,
  Send,
  Loader2,
  ChevronDown,
  ChevronRight,
  Lock,
  Cpu,
  Database,
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
import { useActiveAiModel, useAskDataPool, useDataPools } from "@/hooks/useAssistant";
import { useSalesAccelerator } from "@/hooks/useLicense";
import type { PoolAnswer } from "@/lib/tauri-commands";

type Turn = { question: string; answer: PoolAnswer | null };

/** Idea shortcuts. `query` prefills the box; `soon` are roadmap placeholders. */
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
  { label: "Write an email for my prospect", kind: "soon" },
  { label: "Create an activity report for my boss", kind: "soon" },
];

export default function AssistantPage() {
  const entitled = useSalesAccelerator();
  return entitled ? <AssistantFeature /> : <AssistantUpsell />;
}

function AssistantFeature() {
  const activeModel = useActiveAiModel();
  const pools = useDataPools();
  const ask = useAskDataPool();

  const poolList = useMemo(() => pools.data ?? [], [pools.data]);
  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);

  const modelReady = !!activeModel.data;

  useEffect(() => {
    if (!selectedPoolId && poolList.length) setSelectedPoolId(poolList[0].id);
  }, [poolList, selectedPoolId]);

  const canAsk = modelReady && !!selectedPoolId && !!question.trim() && !ask.isPending;

  async function send(text: string) {
    const q = text.trim();
    if (!q || !selectedPoolId || !modelReady || ask.isPending) return;
    setQuestion("");
    const res = await ask.mutateAsync({ pool_id: selectedPoolId, question: q }).catch(() => null);
    setTurns((t) => [...t, { question: q, answer: res }]);
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-4 p-6">
        <header>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Sparkles className="h-6 w-6 text-primary" /> Sales Accelerator
          </h1>
          <p className="text-sm text-muted-foreground">
            Ask questions about your sales data in plain English — runs 100% on your machine.
          </p>
        </header>

        {!modelReady ? (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Cpu className="h-4 w-4" /> Set up your AI model
              </CardTitle>
              <CardDescription>
                Choose and download a local AI model to power the assistant.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link to="/settings">
                <Button size="sm">Open Settings</Button>
              </Link>
            </CardContent>
          </Card>
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
            </div>

            <div className="sticky bottom-0 space-y-2 bg-background pt-2">
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground">Data:</label>
                <select
                  value={selectedPoolId ?? ""}
                  onChange={(e) => setSelectedPoolId(e.target.value)}
                  className="rounded-md border bg-background px-2 py-1 text-xs"
                >
                  {poolList.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2">
                <Input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canAsk) send(question);
                  }}
                  placeholder="Ask about your data…"
                />
                <Button onClick={() => send(question)} disabled={!canAsk}>
                  {ask.isPending ? (
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

function TurnView({ turn }: { turn: Turn }) {
  const [showSql, setShowSql] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-primary px-4 py-2 text-sm text-primary-foreground">
          {turn.question}
        </div>
      </div>
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
              <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
                <code>{turn.answer.sql}</code>
              </pre>
              <ResultTable
                columns={turn.answer.columns}
                rows={turn.answer.rows}
                truncated={turn.answer.truncated}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="max-w-[90%] rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive">
          Sorry, I couldn't answer that one. Try rephrasing the question.
        </div>
      )}
    </div>
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
            Ask questions about your Salesforce data in plain English, with a private AI
            assistant that runs entirely on your machine — no data ever leaves your device.
          </p>
          <p>
            Your current licence doesn't include this tier. Contact us to upgrade and unlock
            the Assistant.
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
