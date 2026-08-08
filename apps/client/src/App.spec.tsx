import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import App from "./App";

vi.mock("@/hooks/use-track-origin", () => ({ useTrackOrigin: vi.fn() }));
vi.mock("@/ee/hooks/use-redirect-to-cloud-select.tsx", () => ({
  useRedirectToCloudSelect: vi.fn(),
}));
vi.mock("@/features/auth/hooks/use-auth", () => ({
  default: () => ({ isLoading: false, signIn: vi.fn() }),
}));
vi.mock("@/features/auth/hooks/use-redirect-if-authenticated.ts", () => ({
  useRedirectIfAuthenticated: vi.fn(),
}));
vi.mock("@/features/workspace/queries/workspace-query.ts", () => ({
  useWorkspacePublicDataQuery: () => ({
    data: { authProviders: [], enforceSso: false },
    isError: false,
    isLoading: false,
  }),
}));
vi.mock("@/ee/components/sso-login.tsx", () => ({ default: () => null }));
vi.mock("@/pages/auth/login", () => ({
  default: () => <h1>Login</h1>,
}));
vi.mock("@/components/layouts/global/layout.tsx", async () => {
  const { Outlet } = await import("react-router-dom");

  return { default: () => <Outlet /> };
});
vi.mock("@/features/page/queries/page-query", () => ({
  usePageQuery: () => ({
    data: {
      id: "page-id",
      title: "Workspace page",
      content: {},
      slugId: "page-id",
      space: { slug: "workspace" },
      permissions: { canEdit: true },
      isBase: false,
    },
    isLoading: false,
    isError: false,
  }),
}));
vi.mock("@/features/space/queries/space-query", () => ({
  useGetSpaceBySlugQuery: () => ({
    data: { settings: { comments: { allowViewerComments: false } } },
  }),
}));
vi.mock("@/features/editor/title-editor", () => ({
  TitleEditor: () => null,
}));
vi.mock("@/features/editor/full-editor", () => ({
  FullEditor: () => <div data-testid="full-editor" />,
}));
vi.mock("@/features/editor/readonly-page-editor.tsx", () => ({
  default: () => <div data-testid="readonly-page-editor" />,
}));
vi.mock("@/features/share/queries/share-query.ts", () => ({
  useSharePageQuery: () => ({
    data: {
      page: { id: "shared-page-id", title: "Shared page", content: {} },
      share: { id: "share-id", key: "share-key", searchIndexing: false },
      features: [],
    },
    isLoading: false,
    isError: false,
  }),
}));
vi.mock("@/features/share/components/share-layout.tsx", async () => {
  const { Outlet } = await import("react-router-dom");

  return { default: () => <Outlet /> };
});
vi.mock("@/features/page-history/components/history-modal", () => ({
  default: () => null,
}));
vi.mock("@/features/page/components/header/page-header.tsx", () => ({
  default: () => null,
}));
vi.mock("@/ee/base/components/base-view", () => ({ BaseView: () => null }));
vi.mock("@/ee/hooks/use-feature", () => ({ useHasFeature: () => false }));
vi.mock("@/main.tsx", async () => {
  const { QueryClient } = await import("@tanstack/react-query");

  return { queryClient: new QueryClient() };
});
vi.mock("@/main", async () => {
  const { QueryClient } = await import("@tanstack/react-query");

  return { queryClient: new QueryClient() };
});
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();

  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

it("renders a lazy route page through the shared suspense boundary", async () => {
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <MantineProvider>
        <HelmetProvider>
          <App />
        </HelmetProvider>
      </MantineProvider>
    </MemoryRouter>,
  );

  expect(
    (await screen.findByRole("heading", { name: /login/i })).textContent,
  ).toMatch(/login/i);
});

it("loads the full editor for a resolved workspace page route", async () => {
  render(
    <MemoryRouter initialEntries={["/s/workspace/p/workspace-page-id"]}>
      <MantineProvider>
        <HelmetProvider>
          <App />
        </HelmetProvider>
      </MantineProvider>
    </MemoryRouter>,
  );

  expect(await screen.findByTestId("full-editor")).toBeTruthy();
});

it("loads the readonly editor for a shared page route", async () => {
  render(
    <MemoryRouter initialEntries={["/share/share-key/p/shared-page-slug"]}>
      <MantineProvider>
        <HelmetProvider>
          <App />
        </HelmetProvider>
      </MantineProvider>
    </MemoryRouter>,
  );

  expect(await screen.findByTestId("readonly-page-editor")).toBeTruthy();
});
