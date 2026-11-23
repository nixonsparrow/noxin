import { transferableAbortController } from "node:util";
import { fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { createAppRoutes } from "./App";
import type { NoxinModule } from "./modules";
import { modules as registeredModules } from "./modules";

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

test("opens the local AI module and sends selected document text through its own API", async () => {
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/ai/health") {
      return Response.json({ ready: true, web: false });
    }
    if (url === "/api/ai/document?kind=pdf&page=1&ocr=0") {
      expect(options?.body).toBeInstanceOf(File);
      return Response.json({ page: 1, pages: 2, ocr: false, fragments: ["Faktura 724", "Brutto 123 PLN"] });
    }
    expect(url).toBe("/api/ai/chat");
    expect(options?.headers).toMatchObject({ "X-Noxin-Request": "1" });
    expect(JSON.parse(options?.body as string)).toMatchObject({
      preset: "invoice",
      source: "Brutto 123 PLN",
    });
    return Response.json({ text: "Kwota brutto to 123 PLN.", seconds: 1, limited: false, trimmed: false });
  });
  vi.stubGlobal("fetch", fetch);
  renderAt("/", registeredModules);
  fireEvent.click(screen.getByRole("link", { name: /Lokalny czat AI/ }));
  await screen.findByText("Lokalny model gotowy");
  fireEvent.change(screen.getByLabelText("Dokument PDF lub DOCX"), {
    target: { files: [new File(["%PDF-1.4"], "faktura.pdf")] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Odczytaj stronę dokumentu" }));
  await screen.findByText("Strona 1 z 2");
  fireEvent.change(screen.getByLabelText("Fragment"), { target: { value: "1" } });
  fireEvent.change(screen.getByLabelText("Zadanie"), { target: { value: "invoice" } });
  fireEvent.click(screen.getByRole("button", { name: "Wyślij" }));
  expect(await screen.findByText("Kwota brutto to 123 PLN.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Wyczyść rozmowę" }));
  expect(screen.queryByText("Kwota brutto to 123 PLN.")).toBeNull();
  expect(screen.queryByText("Brutto 123 PLN")).toBeNull();
});
