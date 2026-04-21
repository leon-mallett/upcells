import { create } from "zustand";

export type DateFormatChoice = "iso" | "international" | "us";

interface DateFormatStore {
  choice: DateFormatChoice;
  setChoice: (choice: DateFormatChoice) => void;
}

const STORAGE_KEY = "upcells.dateFormat";

/** Pick a sensible default based on the user's browser locale. Pure ISO is
 *  always safe for SF (dates round-trip as YYYY-MM-DD), but when the user
 *  edits a date cell in Excel, Excel reformats it to the OS locale — and
 *  that's what we need to parse on import. */
function detectDefault(): DateFormatChoice {
  if (typeof navigator === "undefined") return "iso";
  const lang = navigator.language || "en-US";
  // en-US, en-CA (partially), en-PH use MM/DD/YYYY; most everything else is DD/MM
  if (/^en-(US|PH)/i.test(lang)) return "us";
  return "international";
}

export const useDateFormatStore = create<DateFormatStore>((set) => ({
  choice:
    (typeof window !== "undefined"
      ? (localStorage.getItem(STORAGE_KEY) as DateFormatChoice | null)
      : null) ?? detectDefault(),
  setChoice: (choice) => {
    localStorage.setItem(STORAGE_KEY, choice);
    set({ choice });
  },
}));
