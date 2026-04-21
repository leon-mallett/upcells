import { useState, useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Database,
  Upload,
  History,
  Settings,
  FileText,
  Search,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { useSavedQueries } from "@/hooks/useQueries";
import { useAdminStore } from "@/stores/adminStore";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PaletteItem {
  id: string;
  label: string;
  category: string;
  subtitle?: string;
  icon: typeof Database;
  action: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { data: savedQueries = [] } = useSavedQueries();
  const adminEnabled = useAdminStore((s) => s.enabled);

  // ── Global Cmd+K listener ─────────────────────────────────────────────────
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((o) => {
          if (!o) {
            setSearch("");
            setSelectedIdx(0);
          }
          return !o;
        });
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // ── Build items ───────────────────────────────────────────────────────────
  const items: PaletteItem[] = [
    { id: "nav-dashboard", label: "Dashboard", category: "Navigate", icon: LayoutDashboard, action: () => navigate({ to: "/dashboard" }) },
    { id: "nav-data", label: "Data", category: "Navigate", icon: Database, action: () => navigate({ to: "/data", search: {} }) },
    { id: "nav-update", label: "Update CRM", category: "Navigate", icon: Upload, action: () => navigate({ to: "/update" }) },
    { id: "nav-history", label: "History", category: "Navigate", icon: History, action: () => navigate({ to: "/history" }) },
    { id: "nav-settings", label: "Settings", category: "Navigate", icon: Settings, action: () => navigate({ to: "/settings" }) },
    ...(adminEnabled
      ? [{ id: "nav-admin", label: "Admin", category: "Navigate" as const, icon: ShieldCheck, action: () => navigate({ to: "/admin" }) }]
      : []),
    { id: "act-new-query", label: "New query", category: "Actions", icon: Plus, action: () => navigate({ to: "/data", search: {} }) },
    ...savedQueries.map((q) => ({
      id: `q-${q.id}`,
      label: q.name,
      category: "Saved queries",
      subtitle: q.object_name ?? undefined,
      icon: FileText,
      action: () => navigate({ to: "/data", search: { q: q.id } }),
    })),
  ];

  // ── Filter ────────────────────────────────────────────────────────────────
  const searchLower = search.toLowerCase();
  const filtered = searchLower
    ? items.filter(
        (i) =>
          i.label.toLowerCase().includes(searchLower) ||
          (i.subtitle && i.subtitle.toLowerCase().includes(searchLower))
      )
    : items;

  // Clamp selection
  const clamped = Math.min(selectedIdx, Math.max(0, filtered.length - 1));
  if (clamped !== selectedIdx) setSelectedIdx(clamped);

  // ── Execute ───────────────────────────────────────────────────────────────
  function execute(item: PaletteItem) {
    item.action();
    setOpen(false);
    setSearch("");
  }

  // ── Key nav inside the palette ────────────────────────────────────────────
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[selectedIdx]) execute(filtered[selectedIdx]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  // Reset selection when search changes
  useEffect(() => setSelectedIdx(0), [search]);

  // Scroll selected into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  if (!open) return null;

  // ── Group items by category for display ────────────────────────────────────
  const groups: { category: string; items: PaletteItem[] }[] = [];
  for (const item of filtered) {
    const last = groups[groups.length - 1];
    if (last && last.category === item.category) {
      last.items.push(item);
    } else {
      groups.push({ category: item.category, items: [item] });
    }
  }

  // Flat index tracker for keyboard highlight
  let flatIndex = -1;

  return (
    <div className="fixed inset-0 z-[100]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-background/60 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />

      {/* Panel */}
      <div className="mx-auto mt-[15vh] w-full max-w-lg px-4">
        <div
          className="overflow-hidden rounded-xl border bg-popover shadow-2xl"
          onKeyDown={handleKeyDown}
        >
          {/* Search input */}
          <div className="flex items-center gap-2 border-b px-3 py-2.5">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              autoFocus
              placeholder="Type a command…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              spellCheck={false}
            />
            <kbd className="hidden select-none rounded border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground sm:inline">
              esc
            </kbd>
          </div>

          {/* Results */}
          <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No results for "{search}"
              </p>
            ) : (
              groups.map((group) => (
                <div key={group.category}>
                  <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground/60">
                    {group.category}
                  </p>
                  {group.items.map((item) => {
                    flatIndex++;
                    const isSelected = flatIndex === selectedIdx;
                    const idx = flatIndex; // capture for click
                    return (
                      <button
                        key={item.id}
                        onClick={() => execute(item)}
                        onMouseEnter={() => setSelectedIdx(idx)}
                        className={cn(
                          "flex w-full items-center gap-3 px-3 py-2 text-left text-sm",
                          isSelected
                            ? "bg-accent text-accent-foreground"
                            : "text-foreground"
                        )}
                      >
                        <item.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.subtitle && (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {item.subtitle}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          {/* Footer hint */}
          <div className="flex items-center justify-between border-t px-3 py-1.5 text-[10px] text-muted-foreground/60">
            <span>↑↓ navigate · ↵ select · esc close</span>
            <span>⌘K to toggle</span>
          </div>
        </div>
      </div>
    </div>
  );
}
