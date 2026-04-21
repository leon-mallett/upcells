import { create } from "zustand";
import type { Connection } from "@/lib/tauri-commands";

interface ConnectionStore {
  connections: Connection[];
  activeConnectionId: string | null;
  setConnections: (connections: Connection[]) => void;
  upsertConnection: (connection: Connection) => void;
  removeConnection: (id: string) => void;
  setActiveConnection: (id: string | null) => void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  connections: [],
  activeConnectionId: null,

  setConnections: (connections) => set({ connections }),

  upsertConnection: (connection) =>
    set((state) => {
      const idx = state.connections.findIndex((c) => c.id === connection.id);
      if (idx >= 0) {
        const updated = [...state.connections];
        updated[idx] = connection;
        return { connections: updated };
      }
      return { connections: [...state.connections, connection] };
    }),

  removeConnection: (id) =>
    set((state) => ({
      connections: state.connections.filter((c) => c.id !== id),
      activeConnectionId:
        state.activeConnectionId === id ? null : state.activeConnectionId,
    })),

  setActiveConnection: (id) => set({ activeConnectionId: id }),
}));
