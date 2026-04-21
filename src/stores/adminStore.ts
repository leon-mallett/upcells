import { create } from "zustand";

interface AdminStore {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

const STORAGE_KEY = "upcells.adminMode";

export const useAdminStore = create<AdminStore>((set) => ({
  enabled:
    typeof window !== "undefined"
      ? localStorage.getItem(STORAGE_KEY) === "true"
      : false,
  setEnabled: (enabled) => {
    localStorage.setItem(STORAGE_KEY, String(enabled));
    set({ enabled });
  },
}));
