import { create } from "zustand";

interface UiStore {
  sidebarOpen: boolean;
  connectionFormOpen: boolean;
  editingConnectionId: string | null;
  toggleSidebar: () => void;
  openConnectionForm: (editId?: string) => void;
  closeConnectionForm: () => void;
}

export const useUiStore = create<UiStore>((set) => ({
  sidebarOpen: true,
  connectionFormOpen: false,
  editingConnectionId: null,

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  openConnectionForm: (editId) =>
    set({ connectionFormOpen: true, editingConnectionId: editId ?? null }),

  closeConnectionForm: () =>
    set({ connectionFormOpen: false, editingConnectionId: null }),
}));
