import {
  createRouter,
  RouterProvider,
  createRootRoute,
  createRoute,
  createHashHistory,
  redirect,
} from "@tanstack/react-router";
import AppShell from "@/components/layout/AppShell";
import DashboardPage from "./DashboardPage";
import SalesDataPage from "./SalesDataPage";
import ImportPage from "./ImportPage";
import HistoryPage from "./HistoryPage";
import AdminPage from "./AdminPage";
import AssistantPage from "./AssistantPage";
import SettingsPage from "./SettingsPage";

// ── Route tree ────────────────────────────────────────────────────────────────

const rootRoute = createRootRoute({
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/dashboard" });
  },
  component: () => null,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard",
  component: DashboardPage,
});

const dataRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/data",
  component: SalesDataPage,
  validateSearch: (search: Record<string, unknown>): { q?: string } => ({
    q: typeof search.q === "string" ? search.q : undefined,
  }),
});

const updateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/update",
  component: ImportPage,
});

const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/history",
  component: HistoryPage,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: AdminPage,
});

const assistantRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/assistant",
  component: AssistantPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  dashboardRoute,
  dataRoute,
  updateRoute,
  historyRoute,
  adminRoute,
  assistantRoute,
  settingsRoute,
]);

const hashHistory = createHashHistory();

const router = createRouter({
  routeTree,
  history: hashHistory,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// ── App entry ─────────────────────────────────────────────────────────────────

export default function MainApp() {
  return <RouterProvider router={router} />;
}
