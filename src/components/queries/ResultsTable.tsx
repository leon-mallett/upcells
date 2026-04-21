import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { ArrowUp, ArrowDown, Search, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { QueryResult } from "@/lib/tauri-commands";

interface Props {
  result: QueryResult;
}

type SortDirection = "asc" | "desc";

const PAGE_SIZE_OPTIONS = [50, 100, 200, 500, 1000] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if (obj.Name && typeof obj.Name === "string") return obj.Name;
    return JSON.stringify(val);
  }
  return String(val);
}

/** Type-aware comparator with nulls always sorted last. */
function compareValues(a: unknown, b: unknown, direction: SortDirection): number {
  const aNull = a === null || a === undefined || a === "";
  const bNull = b === null || b === undefined || b === "";
  if (aNull && bNull) return 0;
  if (aNull) return 1; // nulls always last regardless of direction
  if (bNull) return -1;

  // Numbers
  if (typeof a === "number" && typeof b === "number") {
    return direction === "asc" ? a - b : b - a;
  }

  // Booleans — false < true
  if (typeof a === "boolean" && typeof b === "boolean") {
    const av = a ? 1 : 0;
    const bv = b ? 1 : 0;
    return direction === "asc" ? av - bv : bv - av;
  }

  // Strings (covers dates in ISO format too, since they sort lexicographically)
  const aStr = String(a);
  const bStr = String(b);
  const cmp = aStr.localeCompare(bStr, undefined, { numeric: true });
  return direction === "asc" ? cmp : -cmp;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function ResultsTable({ result }: Props) {
  const { columns, records, total_size, fetched_count } = result;

  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [searchText, setSearchText] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(200);

  // ── Column resize state ──────────────────────────────────────────────────
  const tableRef = useRef<HTMLTableElement>(null);
  const [colWidths, setColWidths] = useState<Record<string, number> | null>(null);
  const resizeRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  const startResize = useCallback(
    (col: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // On first resize, snapshot every column's current DOM width so we
      // can switch to table-layout: fixed without changing the appearance.
      let widths = colWidths;
      if (!widths) {
        const ths = tableRef.current?.querySelectorAll<HTMLTableCellElement>("thead th");
        if (ths) {
          widths = {};
          ths.forEach((th, i) => {
            if (columns[i]) widths![columns[i]] = th.getBoundingClientRect().width;
          });
          setColWidths(widths);
        }
      }

      const th = (e.target as HTMLElement).closest("th");
      resizeRef.current = {
        col,
        startX: e.clientX,
        startWidth: widths?.[col] ?? th?.getBoundingClientRect().width ?? 150,
      };
      setIsResizing(true);
    },
    [colWidths, columns]
  );

  useEffect(() => {
    if (!isResizing) return;

    function onMouseMove(e: MouseEvent) {
      if (!resizeRef.current) return;
      const diff = e.clientX - resizeRef.current.startX;
      const newWidth = Math.max(40, resizeRef.current.startWidth + diff);
      setColWidths((prev) => (prev ? { ...prev, [resizeRef.current!.col]: newWidth } : null));
    }

    function onMouseUp() {
      resizeRef.current = null;
      setIsResizing(false);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isResizing]);

  // Reset local state whenever a fresh result comes in — columns may change
  // between queries, which would break any lingering sort-by-column.
  useEffect(() => {
    setSortColumn(null);
    setSortDirection("asc");
    setSearchText("");
    setPage(0);
    setColWidths(null);
  }, [result]);

  // Reset page whenever search/sort/pageSize changes so the user isn't left
  // stranded on page 47 of a now-10-row filtered result.
  useEffect(() => {
    setPage(0);
  }, [searchText, sortColumn, sortDirection, pageSize]);

  // ── Pipeline: search → sort → paginate ─────────────────────────────────
  const searchLower = searchText.trim().toLowerCase();
  const filteredRecords = useMemo(() => {
    if (!searchLower) return records;
    return records.filter((record) =>
      columns.some((col) => {
        const val = (record as Record<string, unknown>)[col];
        if (val == null) return false;
        return String(val).toLowerCase().includes(searchLower);
      })
    );
  }, [records, columns, searchLower]);

  const sortedRecords = useMemo(() => {
    if (!sortColumn) return filteredRecords;
    return [...filteredRecords].sort((a, b) =>
      compareValues(
        (a as Record<string, unknown>)[sortColumn],
        (b as Record<string, unknown>)[sortColumn],
        sortDirection
      )
    );
  }, [filteredRecords, sortColumn, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sortedRecords.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const startIdx = currentPage * pageSize;
  const endIdx = Math.min(startIdx + pageSize, sortedRecords.length);
  const pagedRecords = sortedRecords.slice(startIdx, endIdx);

  // ── Handlers ───────────────────────────────────────────────────────────
  function handleSort(col: string) {
    if (sortColumn === col) {
      // Toggle direction, or clear on third click
      if (sortDirection === "asc") {
        setSortDirection("desc");
      } else {
        setSortColumn(null);
      }
    } else {
      setSortColumn(col);
      setSortDirection("asc");
    }
  }

  const truncated = total_size > fetched_count;
  const filteredByCount = filteredRecords.length;
  const hasFilter = searchLower !== "";

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Toolbar ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 border-b bg-muted/30 px-4 py-1.5">
        <span className="text-xs text-muted-foreground">
          {fetched_count === 0 ? (
            "No records returned"
          ) : hasFilter ? (
            <>
              {filteredByCount.toLocaleString()} of{" "}
              {fetched_count.toLocaleString()} records match
            </>
          ) : truncated ? (
            <>
              Showing {fetched_count.toLocaleString()} of{" "}
              {total_size.toLocaleString()} records — increase LIMIT to see more
            </>
          ) : (
            <>
              {fetched_count.toLocaleString()} record
              {fetched_count === 1 ? "" : "s"}
            </>
          )}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {/* Search */}
          {fetched_count > 0 && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Filter rows…"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                className="h-7 w-48 pl-7 pr-7 text-xs"
              />
              {searchText && (
                <button
                  onClick={() => setSearchText("")}
                  aria-label="Clear filter"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
          <span className="text-xs text-muted-foreground">
            {columns.length} column{columns.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      {/* ── Table ────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto">
        {pagedRecords.length === 0 && fetched_count === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">
              Query returned no results
            </p>
          </div>
        ) : pagedRecords.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">
              No rows match "{searchText}"
            </p>
          </div>
        ) : (
          <table
            ref={tableRef}
            className={cn(
              "w-full border-collapse text-sm",
              colWidths && "table-fixed"
            )}
            style={
              colWidths
                ? { width: Object.values(colWidths).reduce((a, b) => a + b, 0) }
                : undefined
            }
          >
            <thead className="sticky top-0 z-20 bg-muted/80 backdrop-blur-sm">
              <tr>
                {columns.map((col, colIdx) => {
                  const isSorted = sortColumn === col;
                  const isFirst = colIdx === 0;
                  return (
                    <th
                      key={col}
                      onClick={() => handleSort(col)}
                      style={colWidths?.[col] ? { width: colWidths[col] } : undefined}
                      className={cn(
                        "relative cursor-pointer select-none border-b border-r px-3 py-2 text-left text-xs font-semibold text-muted-foreground last:border-r-0 hover:bg-muted",
                        isFirst &&
                          "sticky left-0 z-30 bg-muted/95 shadow-[1px_0_0_0_hsl(var(--border))]"
                      )}
                    >
                      <div className="flex items-center gap-1">
                        <span className="truncate">{col}</span>
                        {isSorted &&
                          (sortDirection === "asc" ? (
                            <ArrowUp className="h-3 w-3 shrink-0 text-foreground" />
                          ) : (
                            <ArrowDown className="h-3 w-3 shrink-0 text-foreground" />
                          ))}
                      </div>
                      {/* Resize handle */}
                      <div
                        onMouseDown={(e) => startResize(col, e)}
                        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/40 active:bg-primary/60"
                      />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {pagedRecords.map((row, i) => (
                <tr key={startIdx + i} className="border-b hover:bg-muted/20">
                  {columns.map((col, colIdx) => {
                    const val = (row as Record<string, unknown>)[col];
                    const display = formatValue(val);
                    const isFirst = colIdx === 0;
                    const isNull = val === null || val === undefined;
                    return (
                      <td
                        key={col}
                        style={colWidths?.[col] ? { width: colWidths[col] } : undefined}
                        className={cn(
                          "border-r px-3 py-1.5 text-xs last:border-r-0",
                          !colWidths && "max-w-xs",
                          isFirst &&
                            "sticky left-0 z-10 bg-background shadow-[1px_0_0_0_hsl(var(--border))]"
                        )}
                        title={display.length > 60 ? display : undefined}
                      >
                        <span
                          className={cn(
                            "block truncate",
                            isNull && "italic text-muted-foreground/40"
                          )}
                        >
                          {isNull ? "—" : display}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Pagination bar ───────────────────────────────────────────── */}
      {sortedRecords.length > 0 && (
        <div className="flex items-center justify-between border-t bg-muted/20 px-4 py-1.5 text-xs">
          <span className="text-muted-foreground">
            Showing {(startIdx + 1).toLocaleString()}–
            {endIdx.toLocaleString()} of {sortedRecords.length.toLocaleString()}
          </span>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Rows</span>
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                className="h-6 rounded-md border bg-background px-1 text-xs"
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={currentPage === 0}
                aria-label="Previous page"
              >
                <ChevronLeft className="h-3 w-3" />
              </Button>
              <span className="min-w-12 text-center text-muted-foreground">
                {currentPage + 1} / {totalPages}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                onClick={() =>
                  setPage((p) => Math.min(totalPages - 1, p + 1))
                }
                disabled={currentPage >= totalPages - 1}
                aria-label="Next page"
              >
                <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
