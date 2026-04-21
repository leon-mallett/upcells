import { Outlet } from "@tanstack/react-router";
import Sidebar from "./Sidebar";
import CommandPalette from "./CommandPalette";
import { useConnections } from "@/hooks/useConnections";

export default function AppShell() {
  useConnections();

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <main className="flex flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
      <CommandPalette />
    </div>
  );
}
