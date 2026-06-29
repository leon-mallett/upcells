import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useSearch, useNavigate } from "@tanstack/react-router";
import {
  Play, Save, Plus, X, ChevronDown, ChevronRight, Loader2, RotateCcw, ArrowUpDown, Download, Lock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConnectionStore } from "@/stores/connectionStore";
import {
  useSobjects,
  useDescribeObject,
  useSavedQueries,
  useExecuteQuery,
  useSaveQuery,
  useUpdateSavedQuery,
} from "@/hooks/useQueries";
import { useExportQueryResults } from "@/hooks/useExport";
import type {
  SavedQuery,
  SObjectField,
  QueryResult,
  ExportFormat,
} from "@/lib/tauri-commands";
import ResultsTable from "@/components/queries/ResultsTable";
import SessionExpiredBanner from "@/components/connections/SessionExpiredBanner";

// ── Common Salesforce objects always shown at the top of the selector ──────────
const COMMON_OBJECTS = [
  "Account",
  "Contact",
  "Opportunity",
  "Lead",
  "Case",
  "Task",
  "Event",
  "User",
];

// ── Filter row types ───────────────────────────────────────────────────────────
type FilterOperator =
  | "="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "LIKE"
  | "NOT LIKE"
  | "IN"
  | "NOT IN"
  | "IS NULL"
  | "IS NOT NULL";

interface FilterRow {
  id: string;
  field: string;
  operator: FilterOperator;
  value: string;
}

// ── SOQL builder ──────────────────────────────────────────────────────────────

function needsQuotes(fieldType: string): boolean {
  return !["int", "double", "currency", "percent", "boolean", "date", "datetime"].includes(
    fieldType
  );
}

function buildSoql(
  objectName: string,
  fields: string[],
  filters: FilterRow[],
  fieldMap: Map<string, SObjectField>,
  orderByField: string,
  orderByDir: "ASC" | "DESC",
  limit: number
): string {
  if (!objectName) return "";
  const selectFields = fields.length > 0 ? fields.join(", ") : "Id";
  let soql = `SELECT ${selectFields}\nFROM ${objectName}`;

  const activeFilters = filters.filter(
    (f) =>
      f.field &&
      (f.operator === "IS NULL" ||
        f.operator === "IS NOT NULL" ||
        f.value.trim() !== "")
  );

  if (activeFilters.length > 0) {
    const whereParts = activeFilters.map((f) => {
      if (f.operator === "IS NULL") return `${f.field} = NULL`;
      if (f.operator === "IS NOT NULL") return `${f.field} != NULL`;

      const ft = fieldMap.get(f.field)?.field_type ?? "string";

      if (f.operator === "IN" || f.operator === "NOT IN") {
        const vals = f.value
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
        const quoted = needsQuotes(ft)
          ? vals.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(", ")
          : vals.join(", ");
        return `${f.field} ${f.operator} (${quoted})`;
      }

      if (f.operator === "LIKE" || f.operator === "NOT LIKE") {
        return `${f.field} ${f.operator} '${f.value.replace(/'/g, "\\'")}'`;
      }

      const formatted = needsQuotes(ft)
        ? `'${f.value.replace(/'/g, "\\'")}'`
        : f.value;
      return `${f.field} ${f.operator} ${formatted}`;
    });
    soql += `\nWHERE ${whereParts.join("\n  AND ")}`;
  }

  if (orderByField) soql += `\nORDER BY ${orderByField} ${orderByDir}`;
  soql += `\nLIMIT ${limit}`;

  return soql;
}

// ── SOQL parser (inverse of buildSoql) ────────────────────────────────────────
//
// Round-trips the SOQL shapes our builder produces — plus tolerance for simple
// manual edits — back into builder state. Returns null when the query uses
// features the visual builder can't represent (OR, parens, functions,
// aliases, subqueries, relationship traversal), in which case the caller
// should fall back to SOQL-only manual mode.

interface ParsedSoql {
  objectName: string;
  fields: string[];
  filters: FilterRow[];
  orderByField: string;
  orderByDir: "ASC" | "DESC";
  limit: number;
}

function parseSoql(soql: string): ParsedSoql | null {
  const normalized = soql.trim().replace(/\s+/g, " ");

  const m = normalized.match(
    /^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+(\d+))?$/i
  );
  if (!m) return null;

  const [, selectClause, objectName, whereClause, orderByField, orderByDir, limitStr] = m;

  // SELECT fields — allow dotted paths (Account.Name, Owner.Profile.Name),
  // reject functions, aliases, subqueries
  const fields = selectClause.split(",").map((f) => f.trim());
  if (fields.some((f) => !/^[\w.]+$/.test(f))) return null;

  // WHERE — bail on OR and parentheses; only conjunctive chains are supported
  const filters: FilterRow[] = [];
  if (whereClause) {
    if (/\bOR\b|[()]/.test(whereClause)) {
      // Allow parens ONLY if they're for an IN (...) clause. Detect by
      // checking that every open-paren is preceded by " IN " or " NOT IN ".
      const parenCheckOk = [...whereClause.matchAll(/\(/g)].every((match) => {
        const before = whereClause.slice(0, match.index ?? 0).toUpperCase();
        return /\bIN\s*$/.test(before);
      });
      if (!parenCheckOk || /\bOR\b/i.test(whereClause)) return null;
    }

    // Split on AND — but only at top-level (not inside IN (..., ...))
    const parts = splitTopLevelAnd(whereClause);
    for (const part of parts) {
      const filter = parseFilterExpression(part.trim());
      if (!filter) return null;
      filters.push(filter);
    }
  }

  return {
    objectName,
    fields,
    filters,
    orderByField: orderByField || "",
    orderByDir: (orderByDir?.toUpperCase() === "DESC" ? "DESC" : "ASC"),
    limit: limitStr ? parseInt(limitStr, 10) : 200,
  };
}

/** Split WHERE on AND while respecting parentheses (so IN (...) stays intact). */
function splitTopLevelAnd(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (
      depth === 0 &&
      s.slice(i, i + 5).toUpperCase() === " AND "
    ) {
      parts.push(current);
      current = "";
      i += 5;
      continue;
    }
    current += ch;
    i++;
  }
  if (current) parts.push(current);
  return parts;
}

function parseFilterExpression(expr: string): FilterRow | null {
  let m: RegExpMatchArray | null;

  // IS NULL / IS NOT NULL (buildSoql emits these as "= NULL" / "!= NULL")
  if ((m = expr.match(/^(\w+)\s*=\s*NULL$/i))) {
    return { id: crypto.randomUUID(), field: m[1], operator: "IS NULL", value: "" };
  }
  if ((m = expr.match(/^(\w+)\s*!=\s*NULL$/i))) {
    return { id: crypto.randomUUID(), field: m[1], operator: "IS NOT NULL", value: "" };
  }

  // IN / NOT IN
  if ((m = expr.match(/^(\w+)\s+NOT\s+IN\s*\((.*)\)$/i))) {
    return { id: crypto.randomUUID(), field: m[1], operator: "NOT IN", value: unwrapInList(m[2]) };
  }
  if ((m = expr.match(/^(\w+)\s+IN\s*\((.*)\)$/i))) {
    return { id: crypto.randomUUID(), field: m[1], operator: "IN", value: unwrapInList(m[2]) };
  }

  // LIKE / NOT LIKE
  if ((m = expr.match(/^(\w+)\s+NOT\s+LIKE\s+'(.*)'$/i))) {
    return { id: crypto.randomUUID(), field: m[1], operator: "NOT LIKE", value: unescapeQuoted(m[2]) };
  }
  if ((m = expr.match(/^(\w+)\s+LIKE\s+'(.*)'$/i))) {
    return { id: crypto.randomUUID(), field: m[1], operator: "LIKE", value: unescapeQuoted(m[2]) };
  }

  // Comparison — longer operators first so ">=" beats ">"
  const ops: [RegExp, FilterOperator][] = [
    [/^(\w+)\s*>=\s*(.+)$/, ">="],
    [/^(\w+)\s*<=\s*(.+)$/, "<="],
    [/^(\w+)\s*!=\s*(.+)$/, "!="],
    [/^(\w+)\s*=\s*(.+)$/, "="],
    [/^(\w+)\s*>\s*(.+)$/, ">"],
    [/^(\w+)\s*<\s*(.+)$/, "<"],
  ];
  for (const [regex, op] of ops) {
    if ((m = expr.match(regex))) {
      return {
        id: crypto.randomUUID(),
        field: m[1],
        operator: op,
        value: unquoteValue(m[2].trim()),
      };
    }
  }

  return null;
}

function unquoteValue(v: string): string {
  if (v.startsWith("'") && v.endsWith("'")) {
    return unescapeQuoted(v.slice(1, -1));
  }
  return v;
}

function unescapeQuoted(s: string): string {
  return s.replace(/\\'/g, "'");
}

function unwrapInList(v: string): string {
  return v
    .split(",")
    .map((item) => unquoteValue(item.trim()))
    .join(", ");
}

/** Guarantees Id is the first field in the list — the builder treats it as
 *  mandatory so rows stay matchable to their records on round-trip. */
function ensureIdPresent(fields: string[]): string[] {
  if (fields.includes("Id")) return fields;
  return ["Id", ...fields];
}

// ── Page component ─────────────────────────────────────────────────────────────

export default function QueriesPage() {
  const connections = useConnectionStore((s) => s.connections);
  // Include error-state orgs so users whose session expired can still see
  // their org in the picker, alongside a reconnect banner — rather than
  // being silently kicked back to "No org connected".
  const connectedConnections = connections.filter(
    (c) => c.status === "connected" || c.status === "error"
  );

  // ── State ────────────────────────────────────────────────────────────────────
  const [connectionId, setConnectionId] = useState<string>(
    () => connectedConnections[0]?.id ?? ""
  );
  const [objectName, setObjectName] = useState("");
  const [objectSearch, setObjectSearch] = useState("");
  const [objectDropdownOpen, setObjectDropdownOpen] = useState(false);
  const [selectedFields, setSelectedFields] = useState<string[]>(["Id", "Name"]);
  const [fieldSearch, setFieldSearch] = useState("");
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [orderByField, setOrderByField] = useState("");
  const [orderByDir, setOrderByDir] = useState<"ASC" | "DESC">("ASC");
  const [limit, setLimit] = useState(200);
  const [soql, setSoql] = useState("");
  const [soqlManual, setSoqlManual] = useState(false);
  // Advanced SOQL editor visibility — persisted so power users don't have to
  // toggle it open every time.
  const [showAdvanced, setShowAdvanced] = useState<boolean>(
    () => localStorage.getItem("upcells.showAdvancedSoql") === "true"
  );
  const toggleAdvanced = () => {
    setShowAdvanced((v) => {
      localStorage.setItem("upcells.showAdvancedSoql", String(!v));
      return !v;
    });
  };
  const [results, setResults] = useState<QueryResult | null>(null);
  const [activeQueryId, setActiveQueryId] = useState<string | null>(null);
  const [activeQueryName, setActiveQueryName] = useState("");
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveAsNew, setSaveAsNew] = useState(false);
  const [newQueryName, setNewQueryName] = useState("");

  // ── URL-driven query loading ────────────────────────────────────────────────
  // The sidebar navigates with /data?q=<id> to load a saved query, or
  // /data (no params) for a fresh start. An effect below reacts to changes.
  const search = useSearch({ strict: false }) as { q?: string };
  const navigate = useNavigate();
  // Tracks which search.q value we've already applied, so a TanStack Query
  // refetch of savedQueries (which re-fires the effect) doesn't clobber
  // in-progress builder edits.
  const lastAppliedQ = useRef<string | undefined>(undefined);

  // ── Data queries ─────────────────────────────────────────────────────────────
  const { data: sobjects = [] } = useSobjects(connectionId || null);
  const { data: describe, isFetching: describeFetching } = useDescribeObject(
    connectionId || null,
    objectName || null
  );
  // Intentionally unfiltered — saved queries are portable across connections
  // (imported ones don't carry a connection_id), and the sidebar lists them
  // unfiltered, so the Data page must see the same set to resolve ?q=<id>.
  const { data: savedQueries = [] } = useSavedQueries();

  const executeQ = useExecuteQuery();
  const saveQ = useSaveQuery(connectionId);
  const updateQ = useUpdateSavedQuery(connectionId);
  const exportQ = useExportQueryResults();

  // ── Export dropdown state ───────────────────────────────────────────────────
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [includeFeedPostCol, setIncludeFeedPostCol] = useState(false);
  const [includeNoteCol, setIncludeNoteCol] = useState(false);
  const [includeTaskCol, setIncludeTaskCol] = useState(false);
  const [includeCallCol, setIncludeCallCol] = useState(false);
  const [includeEventCol, setIncludeEventCol] = useState(false);

  async function handleExport(format: ExportFormat) {
    setExportMenuOpen(false);
    if (!results || !connectionId) return;

    const conn = connectedConnections.find((c) => c.id === connectionId);
    if (!conn) return;

    const defaultName = `${objectName || "query"}_${new Date()
      .toISOString()
      .slice(0, 10)}.${format}`;

    const path = await saveDialog({
      defaultPath: defaultName,
      filters: [
        {
          name: format === "xlsx" ? "Excel Workbook" : "CSV",
          extensions: [format],
        },
      ],
    });

    if (!path) return; // user cancelled

    const actionColumns: string[] = [];
    if (includeFeedPostCol) actionColumns.push("[Upcells] Feed Post");
    if (includeNoteCol) actionColumns.push("[Upcells] Note");
    if (includeTaskCol) actionColumns.push("[Upcells] Task");
    if (includeCallCol) actionColumns.push("[Upcells] Log Call");
    if (includeEventCol) actionColumns.push("[Upcells] Event");

    exportQ.mutate({
      connection_id: connectionId,
      connection_name: conn.name,
      object_name: objectName || undefined,
      query_id: activeQueryId ?? undefined,
      soql,
      records: results.records,
      columns: results.columns,
      file_path: path,
      format,
      action_columns: actionColumns.length > 0 ? actionColumns : undefined,
    });
  }

  // ── Field map for quick lookup (memoised so it's stable across renders) ──────
  const fieldMap = useMemo(
    () => new Map<string, SObjectField>(describe?.fields.map((f) => [f.name, f]) ?? []),
    [describe]
  );

  // ── Auto-generate SOQL when builder state changes ─────────────────────────────
  const regenerateSoql = useCallback(() => {
    if (!objectName || soqlManual) return;
    setSoql(buildSoql(objectName, selectedFields, filters, fieldMap, orderByField, orderByDir, limit));
  }, [objectName, selectedFields, filters, fieldMap, orderByField, orderByDir, limit, soqlManual]);

  useEffect(() => {
    regenerateSoql();
  }, [regenerateSoql]);

  // ── Keyboard shortcuts (Cmd+Enter → Run, Cmd+S → Save) ────────────────────
  // Using refs so the effect captures the latest closures without re-binding
  // the listener on every render.
  const runQueryRef = useRef(runQuery);
  runQueryRef.current = runQuery;
  const openSaveDialogRef = useRef(openSaveDialog);
  openSaveDialogRef.current = openSaveDialog;
  // Initialised with safe defaults here so the hook call order is stable.
  // `.current` is updated later (after noConnection / isSessionExpired are
  // derived) so the effect always reads fresh values.
  const shortcutCtx = useRef({
    soql: "",
    activeQueryId: null as string | null,
    executeIsPending: false,
    noConnection: true,
    isSessionExpired: false,
  });

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const ctx = shortcutCtx.current;

      if (e.key === "Enter") {
        e.preventDefault();
        if (ctx.soql && !ctx.executeIsPending && !ctx.noConnection && !ctx.isSessionExpired) {
          runQueryRef.current();
        }
      }

      if (e.key === "s") {
        e.preventDefault();
        if (ctx.soql) {
          openSaveDialogRef.current(!!ctx.activeQueryId ? false : true);
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // ── Object selection ──────────────────────────────────────────────────────────
  function selectObject(name: string) {
    setObjectName(name);
    setObjectDropdownOpen(false);
    setObjectSearch("");
    setSelectedFields(["Id", "Name"]);
    setFilters([]);
    setOrderByField("");
    setSoqlManual(false);
    setResults(null);
    setActiveQueryId(null);
    setActiveQueryName("");
  }

  // ── Field toggle ──────────────────────────────────────────────────────────────
  function toggleField(name: string) {
    // Id on the primary object is mandatory — without it, exported rows can't
    // be matched back to their records on update, and every row would be
    // treated as a new insert.
    if (name === "Id") return;
    setSelectedFields((prev) =>
      prev.includes(name) ? prev.filter((f) => f !== name) : [...prev, name]
    );
    setSoqlManual(false);
  }

  function selectAllFields() {
    if (!describe) return;
    setSelectedFields(describe.fields.map((f) => f.name));
    setSoqlManual(false);
  }

  function clearAllFields() {
    setSelectedFields(["Id"]);
    setSoqlManual(false);
  }

  // ── Filters ───────────────────────────────────────────────────────────────────
  function addFilter() {
    const firstFilterableField =
      describe?.fields.find((f) => f.filterable)?.name ?? "";
    setFilters((prev) => [
      ...prev,
      { id: crypto.randomUUID(), field: firstFilterableField, operator: "=", value: "" },
    ]);
    setSoqlManual(false);
  }

  function updateFilter(idx: number, patch: Partial<FilterRow>) {
    setFilters((prev) => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
    setSoqlManual(false);
  }

  function removeFilter(idx: number) {
    setFilters((prev) => prev.filter((_, i) => i !== idx));
    setSoqlManual(false);
  }

  // ── Run query ─────────────────────────────────────────────────────────────────
  function runQuery() {
    if (!connectionId || !soql.trim()) return;

    // Tell the backend exactly which columns to expect so ordering is
    // deterministic and null-reference rows still show the right keys.
    // Builder mode uses selectedFields directly; manual mode tries to parse
    // the typed SOQL to extract them.
    const expectedColumns: string[] | undefined = (() => {
      if (!soqlManual && selectedFields.length > 0) return selectedFields;
      const parsed = parseSoql(soql);
      return parsed?.fields;
    })();

    executeQ.mutate(
      {
        connection_id: connectionId,
        soql,
        query_id: activeQueryId ?? undefined,
        columns: expectedColumns,
      },
      { onSuccess: (r) => setResults(r) }
    );
  }

  // ── Save query ────────────────────────────────────────────────────────────────
  function openSaveDialog(asNew = false) {
    setSaveAsNew(asNew);
    setNewQueryName(asNew ? "" : activeQueryName);
    setSaveDialogOpen(true);
  }

  function confirmSave() {
    if (!newQueryName.trim() || !connectionId) return;

    if (!saveAsNew && activeQueryId) {
      updateQ.mutate(
        { id: activeQueryId, name: newQueryName, soql_text: soql, object_name: objectName || undefined },
        {
          onSuccess: (q) => {
            setActiveQueryName(q.name);
            setSaveDialogOpen(false);
          },
        }
      );
    } else {
      saveQ.mutate(
        {
          name: newQueryName,
          connection_id: connectionId,
          soql_text: soql,
          object_name: objectName || undefined,
        },
        {
          onSuccess: (q) => {
            setActiveQueryId(q.id);
            setActiveQueryName(q.name);
            setSaveDialogOpen(false);
            // Pin the tracking ref BEFORE navigating so the effect doesn't
            // treat the URL change as "load this query" and clobber state.
            lastAppliedQ.current = q.id;
            navigate({ to: "/data", search: { q: q.id } });
          },
        }
      );
    }
  }

  // ── Load saved query ──────────────────────────────────────────────────────────
  function applySavedQueryToBuilder(q: SavedQuery) {
    setActiveQueryId(q.id);
    setActiveQueryName(q.name);
    setResults(null);
    setSoql(q.soql_text);

    // Try to parse the SOQL back into builder state so the user can edit
    // it with the visual tools. Fall back to manual SOQL mode if it uses
    // features the builder can't round-trip.
    const parsed = parseSoql(q.soql_text);
    if (parsed) {
      setObjectName(parsed.objectName);
      setSelectedFields(ensureIdPresent(parsed.fields));
      setFilters(parsed.filters);
      setOrderByField(parsed.orderByField);
      setOrderByDir(parsed.orderByDir);
      setLimit(parsed.limit);
      setSoqlManual(false);
    } else {
      setObjectName(q.object_name ?? "");
      setSelectedFields([]);
      setFilters([]);
      setOrderByField("");
      setSoqlManual(true);
      toast.info(
        `"${q.name}" uses advanced SOQL features — opened in SOQL editor mode`,
        { duration: 6000 }
      );
    }
  }

  function resetQueryBuilder() {
    setObjectName("");
    setSelectedFields(["Id", "Name"]);
    setFilters([]);
    setOrderByField("");
    setLimit(200);
    setSoql("");
    setSoqlManual(false);
    setResults(null);
    setActiveQueryId(null);
    setActiveQueryName("");
  }

  // React to the URL's ?q=<id> parameter. When it changes we either load
  // the saved query or reset the builder (when cleared). `lastAppliedQ`
  // prevents re-applying the same value on unrelated re-renders — in
  // particular, when savedQueries refetches after a save or delete.
  useEffect(() => {
    if (search.q === lastAppliedQ.current) return;

    if (search.q) {
      // Wait for savedQueries to load before we can resolve the id
      if (savedQueries.length === 0) return;
      const q = savedQueries.find((sq) => sq.id === search.q);
      if (q) {
        applySavedQueryToBuilder(q);
        lastAppliedQ.current = search.q;
      }
    } else {
      resetQueryBuilder();
      lastAppliedQ.current = undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.q, savedQueries]);

  // ── Object list for dropdown ──────────────────────────────────────────────────
  const allObjectNames = new Set(sobjects.map((o) => o.name));
  const searchLower = objectSearch.toLowerCase();

  const commonFiltered = COMMON_OBJECTS.filter(
    (n) =>
      n.toLowerCase().includes(searchLower) ||
      (allObjectNames.has(n) &&
        sobjects
          .find((o) => o.name === n)
          ?.label.toLowerCase()
          .includes(searchLower))
  );

  const otherObjects = sobjects
    .filter((o) => !COMMON_OBJECTS.includes(o.name))
    .filter(
      (o) =>
        o.name.toLowerCase().includes(searchLower) ||
        o.label.toLowerCase().includes(searchLower)
    )
    .sort((a, b) => a.label.localeCompare(b.label));

  // ── Filtered fields for the fields panel ─────────────────────────────────────
  const fieldSearchLower = fieldSearch.toLowerCase();
  const allFields = describe?.fields ?? [];
  const visibleFields = allFields
    .filter(
      (f) =>
        f.name.toLowerCase().includes(fieldSearchLower) ||
        f.label.toLowerCase().includes(fieldSearchLower)
    )
    .sort((a, b) => {
      // Id and Name first, then alphabetical by label
      if (a.name === "Id") return -1;
      if (b.name === "Id") return 1;
      if (a.name === "Name") return -1;
      if (b.name === "Name") return 1;
      return a.label.localeCompare(b.label);
    });

  // Parent-relationship entries derived from reference fields. A lookup like
  // Opportunity.AccountId has `relationship_name: "Account"` — we expose that
  // as an expandable "Related" row that fetches the Account describe.
  const visibleRelationships = allFields
    .filter(
      (f) =>
        f.field_type === "reference" &&
        f.relationship_name &&
        f.reference_to.length > 0
    )
    .filter(
      (f) =>
        !fieldSearchLower ||
        f.relationship_name!.toLowerCase().includes(fieldSearchLower) ||
        f.label.toLowerCase().includes(fieldSearchLower)
    )
    .sort((a, b) => a.relationship_name!.localeCompare(b.relationship_name!));

  const noConnection = connectedConnections.length === 0;
  const activeConnection = connectedConnections.find((c) => c.id === connectionId);
  const isSessionExpired = activeConnection?.status === "error";

  // Update the shortcut context ref now that all derived values are available.
  shortcutCtx.current = { soql, activeQueryId, executeIsPending: executeQ.isPending, noConnection, isSessionExpired };

  return (
    <>
      <div className="flex h-full overflow-hidden">
        {/* ── Main Area ─────────────────────────────────────────────────────── */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Header bar — object selector is the primary title */}
          <div className="flex items-center gap-3 border-b px-6 py-3">
            {/* ── Primary: Object selector (page title) ─────────────────── */}
            <div className="relative">
              <Button
                variant="outline"
                className="h-10 gap-2 text-base font-semibold"
                onClick={() => setObjectDropdownOpen((o) => !o)}
                disabled={!connectionId || noConnection}
              >
                {objectName || "Select object…"}
                <ChevronDown className="h-4 w-4" />
              </Button>

              {objectDropdownOpen && (
                <div className="absolute left-0 top-12 z-50 w-72 rounded-md border bg-popover shadow-md">
                  <div className="border-b p-2">
                    <Input
                      placeholder="Search objects…"
                      value={objectSearch}
                      onChange={(e) => setObjectSearch(e.target.value)}
                      className="h-7 text-xs"
                      autoFocus
                    />
                  </div>
                  <div className="max-h-80 overflow-y-auto py-1">
                    {commonFiltered.length > 0 && (
                      <>
                        <p className="px-3 py-1 text-xs font-semibold text-muted-foreground">
                          Common
                        </p>
                        {commonFiltered.map((name) => {
                          const meta = sobjects.find((o) => o.name === name);
                          return (
                            <button
                              key={name}
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted"
                              onClick={() => selectObject(name)}
                            >
                              <span className="font-medium">{name}</span>
                              {meta && (
                                <span className="text-xs text-muted-foreground">
                                  {meta.label}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </>
                    )}
                    {otherObjects.length > 0 && (
                      <>
                        <p className="px-3 py-1 text-xs font-semibold text-muted-foreground">
                          All objects
                        </p>
                        {otherObjects.map((o) => (
                          <button
                            key={o.name}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted"
                            onClick={() => selectObject(o.name)}
                          >
                            <span>{o.label}</span>
                            <span className="text-xs text-muted-foreground">
                              {o.name}
                            </span>
                          </button>
                        ))}
                      </>
                    )}
                    {sobjects.length === 0 && !noConnection && (
                      <p className="px-3 py-3 text-xs text-muted-foreground">
                        Loading objects…
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* ── Secondary: Connection selector ─────────────────────────── */}
            {connectedConnections.length > 1 && (
              <select
                className="h-8 rounded-md border bg-background px-2 text-xs"
                value={connectionId}
                onChange={(e) => {
                  setConnectionId(e.target.value);
                  setObjectName("");
                  setResults(null);
                  setActiveQueryId(null);
                }}
              >
                {connectedConnections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}

            {connectedConnections.length === 1 && (
              <span className="text-xs text-muted-foreground">
                {connectedConnections[0].name}
              </span>
            )}

            {noConnection && (
              <span className="text-xs text-destructive">
                No Salesforce org connected — add one in Settings
              </span>
            )}

            {activeQueryId && (
              <span className="text-xs text-muted-foreground">
                · {activeQueryName}
              </span>
            )}

            <div className="ml-auto flex items-center gap-2">
              {results && results.records.length > 0 && (
                <div className="relative">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => setExportMenuOpen((o) => !o)}
                    disabled={exportQ.isPending}
                  >
                    {exportQ.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Download className="h-3 w-3" />
                    )}
                    Export
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                  {exportMenuOpen && (
                    <div className="absolute right-0 top-9 z-50 w-56 rounded-md border bg-popover shadow-md">
                      {/* Action column toggles */}
                      <div className="border-b px-3 py-2 space-y-1">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Include action columns
                        </p>
                        <label className="flex items-center gap-2 text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            className="h-3 w-3 accent-primary"
                            checked={includeFeedPostCol}
                            onChange={() => setIncludeFeedPostCol((v) => !v)}
                          />
                          Feed Post
                        </label>
                        <label className="flex items-center gap-2 text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            className="h-3 w-3 accent-primary"
                            checked={includeNoteCol}
                            onChange={() => setIncludeNoteCol((v) => !v)}
                          />
                          Note
                        </label>
                        <label className="flex items-center gap-2 text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            className="h-3 w-3 accent-primary"
                            checked={includeTaskCol}
                            onChange={() => setIncludeTaskCol((v) => !v)}
                          />
                          Task
                        </label>
                        <label className="flex items-center gap-2 text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            className="h-3 w-3 accent-primary"
                            checked={includeCallCol}
                            onChange={() => setIncludeCallCol((v) => !v)}
                          />
                          Log Call
                        </label>
                        <label className="flex items-center gap-2 text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            className="h-3 w-3 accent-primary"
                            checked={includeEventCol}
                            onChange={() => setIncludeEventCol((v) => !v)}
                          />
                          Event
                        </label>
                      </div>
                      {/* Format buttons */}
                      <button
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                        onClick={() => handleExport("xlsx")}
                      >
                        <Download className="h-3 w-3" />
                        Excel (.xlsx)
                      </button>
                      <button
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                        onClick={() => handleExport("csv")}
                      >
                        <Download className="h-3 w-3" />
                        CSV (.csv)
                      </button>
                    </div>
                  )}
                </div>
              )}
              {soql && (
                <>
                  {activeQueryId && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => openSaveDialog(false)}
                    >
                      <Save className="h-3 w-3" />
                      Save
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => openSaveDialog(true)}
                  >
                    <Save className="h-3 w-3" />
                    {activeQueryId ? "Save as new" : "Save"}
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={runQuery}
                    disabled={
                      executeQ.isPending ||
                      !connectionId ||
                      noConnection ||
                      isSessionExpired
                    }
                  >
                    {executeQ.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Play className="h-3 w-3" />
                    )}
                    Run
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* Session expired banner */}
          {isSessionExpired && activeConnection && (
            <SessionExpiredBanner connection={activeConnection} />
          )}

          {/* Builder + Results */}
          <div className="flex flex-1 overflow-hidden">
            {/* ── Fields Panel (shown when object selected and not in manual mode) ── */}
            {objectName && !soqlManual && (
              <div className="flex w-64 shrink-0 flex-col border-r overflow-hidden">
                <div className="flex h-10 items-center justify-between border-b px-3">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Fields
                  </span>
                  {describeFetching && (
                    <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                  )}
                  <div className="flex gap-1">
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={selectAllFields}
                    >
                      All
                    </button>
                    <span className="text-muted-foreground/40">·</span>
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={clearAllFields}
                    >
                      None
                    </button>
                  </div>
                </div>
                <div className="border-b px-2 py-1.5">
                  <Input
                    placeholder="Search fields…"
                    value={fieldSearch}
                    onChange={(e) => setFieldSearch(e.target.value)}
                    className="h-6 text-xs"
                  />
                </div>
                <div className="flex-1 overflow-y-auto py-1">
                  {visibleFields.map((f) => {
                    const isMandatory = f.name === "Id";
                    return (
                      <label
                        key={f.name}
                        title={
                          isMandatory
                            ? "Id is required so exported rows can be matched back to their records on update"
                            : undefined
                        }
                        className={cn(
                          "flex items-center gap-2 px-3 py-1 hover:bg-muted/40",
                          isMandatory ? "cursor-default" : "cursor-pointer"
                        )}
                      >
                        <input
                          type="checkbox"
                          className="h-3 w-3 accent-primary disabled:opacity-60"
                          checked={selectedFields.includes(f.name) || isMandatory}
                          onChange={() => toggleField(f.name)}
                          disabled={isMandatory}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1 truncate text-xs">
                            {f.label}
                            {isMandatory && (
                              <Lock className="h-2.5 w-2.5 text-muted-foreground/60" />
                            )}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground/60">
                            {f.name}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground/40">
                          {f.field_type}
                        </span>
                      </label>
                    );
                  })}
                  {allFields.length === 0 && !describeFetching && objectName && (
                    <p className="px-3 py-4 text-xs text-muted-foreground">Loading fields…</p>
                  )}

                  {/* Related (parent relationships) */}
                  {visibleRelationships.length > 0 && (
                    <>
                      <p className="mt-3 border-t px-3 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground/60">
                        Related
                      </p>
                      {visibleRelationships.map((rel) => (
                        <RelationshipGroup
                          key={rel.name}
                          connectionId={connectionId}
                          relationshipName={rel.relationship_name!}
                          targetObject={rel.reference_to[0]}
                          parentLookupName={rel.name}
                          selectedFields={selectedFields}
                          onToggle={toggleField}
                        />
                      ))}
                    </>
                  )}
                </div>
              </div>
            )}

            {/* ── Editor + Filters + Results ──────────────────────────────── */}
            <div className="flex flex-1 flex-col overflow-hidden">
              {/* Builder controls — filters, order, limit (only when an object is chosen) */}
              {objectName && !soqlManual && (
                <>
                  {/* Filters header — fixed h-10 so the border aligns with the Fields header */}
                  <div className="flex h-10 items-center gap-2 border-b px-3">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Filters
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-xs"
                      onClick={addFilter}
                    >
                      <Plus className="h-3 w-3" />
                      Add filter
                    </Button>

                    {/* Order by / Limit on the right */}
                    {describe && (
                      <div className="ml-auto flex items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">Order by</span>
                        <select
                          className="h-7 rounded-md border bg-background px-2 text-xs"
                          value={orderByField}
                          onChange={(e) => { setOrderByField(e.target.value); setSoqlManual(false); }}
                        >
                          <option value="">— none —</option>
                          {describe.fields
                            .filter((f) => f.sortable)
                            .sort((a, b) => a.label.localeCompare(b.label))
                            .map((f) => (
                              <option key={f.name} value={f.name}>
                                {f.label}
                              </option>
                            ))}
                        </select>
                        {orderByField && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-1.5"
                            onClick={() => setOrderByDir((d) => (d === "ASC" ? "DESC" : "ASC"))}
                          >
                            <ArrowUpDown className="h-3 w-3" />
                            <span className="text-xs">{orderByDir}</span>
                          </Button>
                        )}
                        <span className="text-xs text-muted-foreground">Limit</span>
                        <Input
                          type="number"
                          min={1}
                          max={50000}
                          value={limit}
                          onChange={(e) => { setLimit(Number(e.target.value)); setSoqlManual(false); }}
                          className="h-7 w-20 text-xs"
                        />
                      </div>
                    )}
                  </div>

                  {/* Filter rows — separate block so the header border doesn't shift */}
                  {filters.length > 0 && (
                    <div className="space-y-1.5 border-b p-3">
                      {filters.map((f, idx) => (
                        <FilterRowUI
                          key={f.id}
                          filter={f}
                          fields={describe?.fields.filter((fd) => fd.filterable) ?? []}
                          onChange={(patch) => updateFilter(idx, patch)}
                          onRemove={() => removeFilter(idx)}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* Advanced / SOQL editor — always present for power users */}
              <div className="border-b p-3">
                <div>
                  <button
                    onClick={toggleAdvanced}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showAdvanced ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    Advanced · SOQL
                    {soqlManual && !showAdvanced && (
                      <span className="text-amber-600">(SOQL mode)</span>
                    )}
                  </button>

                  {showAdvanced && (
                    <div className="mt-2">
                      <div className="flex items-center justify-end mb-1 gap-2">
                        {soqlManual && (
                          <button
                            className="text-xs text-primary hover:underline"
                            onClick={() => {
                              const parsed = parseSoql(soql);
                              if (parsed) {
                                setObjectName(parsed.objectName);
                                setSelectedFields(ensureIdPresent(parsed.fields));
                                setFilters(parsed.filters);
                                setOrderByField(parsed.orderByField);
                                setOrderByDir(parsed.orderByDir);
                                setLimit(parsed.limit);
                                setSoqlManual(false);
                              } else {
                                toast.error(
                                  "Can't open this in the builder — it uses SOQL features the visual builder doesn't support (OR, functions, subqueries, aliases, relationship traversals). Keep editing here instead.",
                                  { duration: 8000 }
                                );
                              }
                            }}
                          >
                            <RotateCcw className="inline h-2.5 w-2.5 mr-0.5" />
                            Edit in builder
                          </button>
                        )}
                        {soqlManual && (
                          <span className="text-xs text-amber-600">
                            SOQL mode
                          </span>
                        )}
                      </div>
                      <textarea
                        value={soql}
                        onChange={(e) => {
                          setSoql(e.target.value);
                          setSoqlManual(true);
                        }}
                        placeholder={
                          objectName
                            ? "SOQL will appear here…"
                            : "Select an object above to build a query, or type SOQL directly"
                        }
                        className="min-h-[80px] w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                        spellCheck={false}
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Results */}
              {executeQ.isPending && (
                <div className="flex flex-1 items-center justify-center gap-2">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Running query…</span>
                </div>
              )}
              {!executeQ.isPending && results && (
                <div className="flex-1 overflow-hidden">
                  <ResultsTable result={results} />
                </div>
              )}
              {!executeQ.isPending && !results && !soql && (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                  <p className="text-sm text-muted-foreground">
                    Select an object and fields, then click Run
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Close object dropdown on outside click */}
      {objectDropdownOpen && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setObjectDropdownOpen(false)}
        />
      )}
      {/* Close export menu on outside click */}
      {exportMenuOpen && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setExportMenuOpen(false)}
        />
      )}

      {/* Save dialog */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {saveAsNew || !activeQueryId ? "Save query" : "Update query"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="query-name">Query name</Label>
            <Input
              id="query-name"
              value={newQueryName}
              onChange={(e) => setNewQueryName(e.target.value)}
              placeholder="e.g. Open Opportunities"
              onKeyDown={(e) => e.key === "Enter" && confirmSave()}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={confirmSave}
              disabled={!newQueryName.trim() || saveQ.isPending || updateQ.isPending}
            >
              {saveQ.isPending || updateQ.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Relationship group sub-component ──────────────────────────────────────────
//
// Shown under the "Related" heading in the Fields panel. Clicking the row
// expands it and fetches the describe for the target object (lazily — we
// don't hammer the describe API for every relationship on the parent).
// Selecting a child field adds the dotted path (e.g. `Account.Name`) to the
// parent query's selectedFields.

function RelationshipGroup({
  connectionId,
  relationshipName,
  targetObject,
  parentLookupName,
  selectedFields,
  onToggle,
}: {
  connectionId: string;
  /** Relationship name in SOQL — e.g. "Account" for Opportunity.AccountId */
  relationshipName: string;
  /** The SObject type the relationship points to — e.g. "Account" */
  targetObject: string;
  /** The lookup field name on the parent — e.g. "AccountId" */
  parentLookupName: string;
  selectedFields: string[];
  onToggle: (fieldName: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [childSearch, setChildSearch] = useState("");

  // Only fetch the describe once the user expands — keeps us off the API
  // for objects with many relationships.
  const { data: childDescribe, isFetching } = useDescribeObject(
    expanded ? connectionId : null,
    expanded ? targetObject : null
  );

  const selectedCount = selectedFields.filter((f) =>
    f.startsWith(`${relationshipName}.`)
  ).length;

  const childFields = (childDescribe?.fields ?? [])
    .filter((f) => {
      if (!childSearch) return true;
      const q = childSearch.toLowerCase();
      return (
        f.name.toLowerCase().includes(q) || f.label.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      if (a.name === "Id") return -1;
      if (b.name === "Id") return 1;
      if (a.name === "Name") return -1;
      if (b.name === "Name") return 1;
      return a.label.localeCompare(b.label);
    });

  return (
    <div>
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-1.5 px-3 py-1 text-left hover:bg-muted/40"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">
            {relationshipName}
          </span>
          <span className="block truncate text-xs text-muted-foreground/60">
            → {targetObject} ({parentLookupName})
          </span>
        </span>
        {selectedCount > 0 && (
          <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
            {selectedCount}
          </span>
        )}
      </button>

      {expanded && (
        <div className="ml-5 border-l pl-1">
          {isFetching && (
            <p className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading {targetObject} fields…
            </p>
          )}
          {childDescribe && childDescribe.fields.length > 10 && (
            <div className="px-2 py-1">
              <Input
                placeholder={`Search ${targetObject}…`}
                value={childSearch}
                onChange={(e) => setChildSearch(e.target.value)}
                className="h-6 text-xs"
              />
            </div>
          )}
          {childDescribe &&
            childFields.map((cf) => {
              const path = `${relationshipName}.${cf.name}`;
              return (
                <label
                  key={cf.name}
                  className="flex cursor-pointer items-center gap-2 px-2 py-1 hover:bg-muted/40"
                >
                  <input
                    type="checkbox"
                    className="h-3 w-3 accent-primary"
                    checked={selectedFields.includes(path)}
                    onChange={() => onToggle(path)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs">{cf.label}</span>
                    <span className="block truncate text-xs text-muted-foreground/60">
                      {cf.name}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground/40">
                    {cf.field_type}
                  </span>
                </label>
              );
            })}
        </div>
      )}
    </div>
  );
}

// ── Filter row sub-component ───────────────────────────────────────────────────

const OPERATORS: FilterOperator[] = [
  "=", "!=", ">", ">=", "<", "<=", "LIKE", "NOT LIKE", "IN", "NOT IN", "IS NULL", "IS NOT NULL",
];

function FilterRowUI({
  filter,
  fields,
  onChange,
  onRemove,
}: {
  filter: FilterRow;
  fields: SObjectField[];
  onChange: (patch: Partial<FilterRow>) => void;
  onRemove: () => void;
}) {
  const noValue = filter.operator === "IS NULL" || filter.operator === "IS NOT NULL";
  const fieldDef = fields.find((f) => f.name === filter.field);

  function inputType(): string {
    if (!fieldDef) return "text";
    if (fieldDef.field_type === "date") return "date";
    if (fieldDef.field_type === "datetime") return "datetime-local";
    if (["int", "double", "currency", "percent"].includes(fieldDef.field_type)) return "number";
    return "text";
  }

  return (
    <div className="flex items-center gap-1.5">
      {/* Field selector */}
      <select
        className="h-7 flex-1 rounded-md border bg-background px-2 text-xs"
        value={filter.field}
        onChange={(e) => onChange({ field: e.target.value })}
      >
        {fields
          .sort((a, b) => a.label.localeCompare(b.label))
          .map((f) => (
            <option key={f.name} value={f.name}>
              {f.label}
            </option>
          ))}
      </select>

      {/* Operator */}
      <select
        className="h-7 w-28 rounded-md border bg-background px-2 text-xs"
        value={filter.operator}
        onChange={(e) => onChange({ operator: e.target.value as FilterOperator })}
      >
        {OPERATORS.map((op) => (
          <option key={op} value={op}>
            {op}
          </option>
        ))}
      </select>

      {/* Value */}
      {fieldDef?.field_type === "boolean" && !noValue ? (
        <select
          className="h-7 w-24 rounded-md border bg-background px-2 text-xs"
          value={filter.value}
          onChange={(e) => onChange({ value: e.target.value })}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <Input
          type={inputType()}
          value={filter.value}
          onChange={(e) => onChange({ value: e.target.value })}
          disabled={noValue}
          placeholder={
            filter.operator === "IN" || filter.operator === "NOT IN"
              ? "val1, val2, …"
              : filter.operator === "LIKE" || filter.operator === "NOT LIKE"
              ? "Use % as wildcard"
              : ""
          }
          className="h-7 flex-1 text-xs"
        />
      )}

      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" onClick={onRemove}>
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}
