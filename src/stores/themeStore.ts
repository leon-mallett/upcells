import { create } from "zustand";

export type ThemeChoice = "system" | "light" | "dark";

interface ThemeStore {
  choice: ThemeChoice;
  setChoice: (choice: ThemeChoice) => void;
}

const STORAGE_KEY = "upcells.theme";

/** Resolve a ThemeChoice to the actual mode to apply, consulting the OS when
 *  the user has picked "system". */
function resolveChoice(choice: ThemeChoice): "light" | "dark" {
  if (choice === "light" || choice === "dark") return choice;
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyMode(mode: "light" | "dark") {
  const root = document.documentElement;
  if (mode === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

export const useThemeStore = create<ThemeStore>((set) => ({
  choice:
    (typeof window !== "undefined"
      ? (localStorage.getItem(STORAGE_KEY) as ThemeChoice | null)
      : null) ?? "system",
  setChoice: (choice) => {
    localStorage.setItem(STORAGE_KEY, choice);
    applyMode(resolveChoice(choice));
    set({ choice });
  },
}));

/** Call once at app startup to apply the persisted theme and subscribe to
 *  OS changes while the user is on "system". */
export function initTheme() {
  if (typeof window === "undefined") return;

  const { choice } = useThemeStore.getState();
  applyMode(resolveChoice(choice));

  // Listen for OS-level theme flips (only takes effect while on "system")
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (useThemeStore.getState().choice === "system") {
      applyMode(resolveChoice("system"));
    }
  };
  mq.addEventListener("change", handler);
}
