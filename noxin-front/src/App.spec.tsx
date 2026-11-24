import { transferableAbortController } from "node:util";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

test("greys out and disables the AI workspace until the model is available", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    let ready = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe("/api/ai/health");
      return Response.json({ ready, web: true });
    }));
    renderAt("/moduly/ai", registeredModules);
    await screen.findByText("Lokalny model niedostępny");

    const workspace = screen.getByRole("region", { name: "Lokalny czat AI" });
    expect(workspace.classList.contains("ai-workspace-unavailable")).toBe(true);
    const controls = workspace.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
      "input, select, textarea, button",
    );
    expect([...controls].every((control) => control.disabled)).toBe(true);

    ready = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByText("Lokalny model gotowy")).toBeTruthy();
    expect(workspace.classList.contains("ai-workspace-unavailable")).toBe(false);
    expect(screen.getByLabelText<HTMLTextAreaElement>("Wiadomość").disabled).toBe(false);
    expect(screen.getByLabelText<HTMLInputElement>("Dokument PDF lub DOCX").disabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("follows a typed instruction using the whole attached range", async () => {
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/ai/health") {
      return Response.json({ ready: true, web: false, document_ranges: true, document_analysis: true });
    }
    if (url === "/api/ai/document?kind=pdf&ocr=0&whole_document=0&page_from=2&page_to=3") {
      expect(options?.body).toBeInstanceOf(File);
      return Response.json({ page: 2, page_from: 2, page_to: 3, pages: 4, ocr: false, fragments: ["Faktura 724", "Brutto 123 PLN"] });
    }
    expect(url).toBe("/api/ai/analyze");
    expect(options?.headers).toMatchObject({ "X-Noxin-Request": "1" });
    expect(JSON.parse(options?.body as string)).toMatchObject({
      language: "pl",
      preset: "chat",
      messages: [{ role: "user", content: "Podsumuj fakturę" }],
      fragments: ["Faktura 724", "Brutto 123 PLN"],
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
  const from = screen.getByLabelText<HTMLInputElement>("Strona od");
  const to = screen.getByLabelText<HTMLInputElement>("Strona do");
  fireEvent.change(from, { target: { value: "4" } });
  expect(to.value).toBe("4");
  fireEvent.change(to, { target: { value: "3" } });
  expect(from.value).toBe("3");
  fireEvent.change(from, { target: { value: "2" } });
  expect(to.value).toBe("3");
  fireEvent.click(screen.getByRole("button", { name: "Dołącz dokument" }));
  await screen.findByText("Strony 2–3 z 4");
  const command = screen.getByLabelText("Polecenie do dokumentu");
  await waitFor(() => expect(document.activeElement).toBe(command));
  fireEvent.change(screen.getByLabelText("Podgląd fragmentu"), { target: { value: "1" } });
  fireEvent.change(command, { target: { value: "Podsumuj fakturę" } });
  fireEvent.click(screen.getByRole("button", { name: "Analizuj dokument" }));
  expect(await screen.findByText("Kwota brutto to 123 PLN.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Wyczyść rozmowę" }));
  expect(screen.queryByText("Kwota brutto to 123 PLN.")).toBeNull();
  expect(screen.queryByText("Brutto 123 PLN")).toBeNull();
});

test("reads the whole document with the page range disabled", async () => {
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/ai/health") return Response.json({ ready: true, web: false, document_ranges: true, document_analysis: true });
    if (url === "/api/ai/analyze") {
      expect(JSON.parse(options?.body as string)).toMatchObject({
        preset: "summary",
        fragments: ["Cała faktura"],
      });
      return Response.json({ text: "Streszczenie faktury", seconds: 1, limited: false, trimmed: false });
    }
    expect(url).toBe("/api/ai/document?kind=pdf&ocr=1&whole_document=1");
    return Response.json({ page: 1, page_from: 1, page_to: 4, pages: 4, ocr: true, fragments: ["Cała faktura"] });
  });
  vi.stubGlobal("fetch", fetch);
  renderAt("/moduly/ai", registeredModules);
  await screen.findByText("Lokalny model gotowy");
  fireEvent.change(screen.getByLabelText("Dokument PDF lub DOCX"), {
    target: { files: [new File(["%PDF-1.4"], "faktura.pdf")] },
  });
  const from = screen.getByLabelText<HTMLInputElement>("Strona od");
  const to = screen.getByLabelText<HTMLInputElement>("Strona do");
  const wholeDocument = screen.getByRole("checkbox", { name: "Cały dokument" });
  const readDocument = screen.getByRole("button", { name: "Dołącz dokument" });
  fireEvent.change(from, { target: { value: "2" } });
  fireEvent.change(to, { target: { value: "3" } });

  fireEvent.click(wholeDocument);
  fireEvent.click(screen.getByRole("checkbox", { name: "Wymuś OCR" }));
  expect(from.disabled).toBe(true);
  expect(to.disabled).toBe(true);
  fireEvent.click(readDocument);
  await screen.findByText("Strony 1–4 z 4 · OCR");

  fireEvent.click(wholeDocument);
  expect(from.disabled).toBe(false);
  expect(to.disabled).toBe(false);
  expect(from.value).toBe("2");
  expect(to.value).toBe("3");
  fireEvent.change(screen.getByLabelText("Zadanie"), { target: { value: "summary" } });
  fireEvent.click(screen.getByRole("button", { name: "Analizuj dokument" }));
  expect(await screen.findByText("Streszczenie faktury")).toBeTruthy();
});

test("reads a single page on older AI agents without uploading unsupported ranges", async () => {
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/ai/health") return Response.json({ ready: true, web: false });
    if (url === "/api/ai/chat") {
      expect(JSON.parse(options?.body as string)).toMatchObject({ source: "Druga strona" });
      return Response.json({ text: "Omówienie strony", seconds: 1, limited: false, trimmed: false });
    }
    expect(url).toBe("/api/ai/document?kind=pdf&ocr=0&page=2");
    expect(options?.body).toBeInstanceOf(File);
    return Response.json({ page: 2, pages: 3, ocr: false, fragments: ["Druga strona"] });
  });
  vi.stubGlobal("fetch", fetch);
  renderAt("/moduly/ai", registeredModules);
  await screen.findByText("Lokalny model gotowy");
  fireEvent.change(screen.getByLabelText("Dokument PDF lub DOCX"), {
    target: { files: [new File(["%PDF-1.4"], "faktura.pdf")] },
  });
  const readDocument = screen.getByRole("button", { name: "Dołącz dokument" });
  const to = screen.getByLabelText("Strona do");
  fireEvent.change(to, { target: { value: "2" } });
  fireEvent.click(readDocument);
  expect(screen.getByRole("alert").textContent).toContain("wymaga aktualizacji Agenta AI");
  expect(fetch).toHaveBeenCalledTimes(1);

  fireEvent.change(screen.getByLabelText("Strona od"), { target: { value: "2" } });
  fireEvent.click(readDocument);
  expect(await screen.findByText("Strona 2 z 3")).toBeTruthy();
  expect(screen.getByText("Druga strona")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Polecenie do dokumentu"), { target: { value: "Podsumuj" } });
  fireEvent.click(screen.getByRole("button", { name: "Analizuj dokument" }));
  expect(await screen.findByText("Omówienie strony")).toBeTruthy();
});

test("sends a multilingual chat draft with Enter and leaves Shift+Enter to insert a newline", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/ai/health") {
      return Response.json({ ready: true, web: false });
    }
    expect(url).toBe("/api/ai/chat");
    expect(JSON.parse(options?.body as string)).toMatchObject({
      language: "en",
      messages: [{ role: "user", content: "First line\nSecond line" }],
    });
    await pending;
    return Response.json({ text: "English reply", seconds: 1, limited: false, trimmed: false });
  });
  vi.stubGlobal("fetch", fetch);
  renderAt("/moduly/ai", registeredModules);
  await screen.findByText("Lokalny model gotowy");

  const language = screen.getByRole<HTMLSelectElement>("combobox", { name: "Język rozmowy" });
  const draft = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Wiadomość" });
  expect(language.value).toBe("pl");
  fireEvent.change(language, { target: { value: "en" } });
  fireEvent.keyDown(draft, { key: "Enter" });
  fireEvent.change(draft, { target: { value: "First line" } });

  expect(fireEvent.keyDown(draft, { key: "Enter", shiftKey: true })).toBe(true);
  expect(fireEvent.keyDown(draft, { key: "Enter", isComposing: true })).toBe(true);
  expect(fetch.mock.calls.map(([url]) => url)).not.toContain("/api/ai/chat");
  // jsdom leaves default textarea editing to the caller.
  fireEvent.change(draft, { target: { value: "First line\nSecond line" } });
  expect(fireEvent.keyDown(draft, { key: "Enter" })).toBe(false);
  expect(draft.disabled).toBe(true);
  expect(screen.getByText("Model przygotowuje odpowiedź…").getAttribute("role")).toBe("status");
  finish();
  expect(await screen.findByText("English reply")).toBeTruthy();
  expect(draft.disabled).toBe(false);
  expect(screen.queryByText("Model przygotowuje odpowiedź…")).toBeNull();
});
