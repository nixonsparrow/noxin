import { transferableAbortController } from "node:util";
import { fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { createAppRoutes } from "./App";
import type { NoxinModule } from "./modules";

beforeEach(() => {
  // jsdom's AbortSignal is incompatible with the Node Request used by the router.
  vi.stubGlobal("AbortController", transferableAbortController().constructor);
});

afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string, modules: readonly NoxinModule[] = []) {
  const router = createMemoryRouter(createAppRoutes(modules), {
    initialEntries: [path],
  });

  render(<RouterProvider router={router} />);
}

test("shows the empty module catalog", () => {
  renderAt("/");

  expect(screen.getByRole("heading", { name: "Moduły" })).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Brak dostępnych modułów" }),
  ).toBeTruthy();
});

test("loads a registered module when opened and returns to the catalog", async () => {
  const load = vi.fn(async () => ({
    default: () => <h1>Raport miesięczny</h1>,
  }));
  renderAt("/", [
    {
      id: "raporty",
      title: "Raporty",
      description: "Zestawienia miesięczne",
      load,
    },
  ]);

  expect(load).not.toHaveBeenCalled();
  const moduleLink = screen.getByRole("link", { name: /Raporty/ });
  expect(moduleLink.getAttribute("href")).toBe("/moduly/raporty");
  fireEvent.click(moduleLink);

  expect(
    await screen.findByRole("heading", { name: "Raport miesięczny" }),
  ).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("link", { name: "Moduły" }));
  expect(await screen.findByRole("link", { name: /Raporty/ })).toBeTruthy();
});

test("keeps the catalog reachable when opening a module fails", async () => {
  renderAt("/moduly/raporty", [
    {
      id: "raporty",
      title: "Raporty",
      description: "Zestawienia miesięczne",
      load: async () => {
        throw new Error("Module unavailable");
      },
    },
  ]);

  expect(
    await screen.findByRole("heading", {
      name: "Nie udało się otworzyć modułu",
    }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Wróć do modułów" }));
  expect(await screen.findByRole("heading", { name: "Moduły" })).toBeTruthy();
});

test("provides a return link for unknown addresses", () => {
  renderAt("/moduly/nieznany");

  expect(
    screen.getByRole("heading", { name: "Nie znaleziono strony" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "Wróć do modułów" }).getAttribute("href"),
  ).toBe("/");
});
