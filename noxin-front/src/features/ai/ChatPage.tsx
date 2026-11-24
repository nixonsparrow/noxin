import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import "./chat.css";

type Message = { role: "user" | "assistant"; content: string };
type Language = "pl" | "en";
type Health = { ready: boolean; web: boolean; document_ranges?: boolean; document_analysis?: boolean };
type DocumentSource = {
  page_from: number;
  page_to: number;
  pages: number;
  ocr: boolean;
  fragments: string[];
};
type DocumentResponse = Omit<DocumentSource, "page_from" | "page_to"> & {
  page: number;
  page_from?: number;
  page_to?: number;
};
type WebSource = { url: string; text: string; truncated: boolean };
type Source = ({ kind: "document"; name: string } & DocumentSource) |
  ({ kind: "web" } & WebSource);
type Answer = { text: string; seconds: number; limited: boolean; trimmed: boolean };

const presets = [
  ["chat", "Rozmowa"],
  ["summary", "Streszczenie"],
  ["contract", "Analiza umowy"],
  ["invoice", "Odczyt faktury"],
] as const;

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/ai/${path}`, {
    cache: "no-store",
    redirect: "error",
    ...options,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null) {
    throw new Error(data?.error ?? "Brak połączenia z lokalną usługą AI.");
  }
  return data as T;
}

function post<T>(path: string, body: object | File, signal: AbortSignal) {
  const file = body instanceof File;
  return request<T>(path, {
    method: "POST",
    headers: {
      "X-Noxin-Request": "1",
      "Content-Type": file ? "application/octet-stream" : "application/json",
    },
    body: file ? body : JSON.stringify(body),
    signal,
  });
}

export default function ChatPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [preset, setPreset] = useState("chat");
  const [language, setLanguage] = useState<Language>("pl");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [answerInfo, setAnswerInfo] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pageFrom, setPageFrom] = useState(1);
  const [pageTo, setPageTo] = useState(1);
  const [wholeDocument, setWholeDocument] = useState(false);
  const [ocr, setOcr] = useState(false);
  const [url, setUrl] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const [fragment, setFragment] = useState(0);
  const running = useRef<AbortController | null>(null);
  const latest = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const draftInput = useRef<HTMLTextAreaElement>(null);
  const focusDocumentCommand = useRef(false);
  const documentSource = source?.kind === "document" ? source : null;
  const sourceText = source?.kind === "document" ? source.fragments[fragment] : source?.text;
  const unavailable = health?.ready === false;
  const controlsDisabled = unavailable || !!busy;
  const canSend = Boolean(health?.ready && !busy && (preset === "chat" ? draft.trim() : sourceText));
  const pageRangeDisabled = controlsDisabled || wholeDocument;

  useEffect(() => {
    const controller = new AbortController();
    const check = () => {
      request<Health>("health", { signal: controller.signal })
        .then((status) => { if (!controller.signal.aborted) setHealth(status); })
        .catch(() => { if (!controller.signal.aborted) setHealth({ ready: false, web: false }); });
    };
    check();
    const timer = window.setInterval(check, 15000);
    return () => {
      window.clearInterval(timer);
      controller.abort();
      running.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (messages.length) latest.current?.scrollIntoView?.({ block: "nearest" });
  }, [messages.length]);

  useEffect(() => {
    if (!controlsDisabled && focusDocumentCommand.current) {
      focusDocumentCommand.current = false;
      draftInput.current?.focus();
    }
  }, [controlsDisabled]);

  async function perform(label: string, operation: (signal: AbortSignal) => Promise<void>) {
    if (unavailable || running.current) return;
    const controller = new AbortController();
    running.current = controller;
    setBusy(label);
    setError("");
    try {
      await operation(controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : "Wystąpił błąd usługi AI.");
      }
    } finally {
      running.current = null;
      if (!controller.signal.aborted) setBusy("");
    }
  }

  function send(event: FormEvent) {
    event.preventDefault();
    if (!canSend) return;
    const analyzeDocument = documentSource && health?.document_analysis;
    if (documentSource && !analyzeDocument && documentSource.fragments.length > 1) {
      setError("Analiza całego wybranego zakresu wymaga aktualizacji Agenta AI.");
      return;
    }
    const defaultCommand = documentSource
      ? (language === "en" ? "Analyze the document." : "Przeanalizuj dokument.")
      : (language === "en" ? "Analyze this excerpt." : "Przeanalizuj ten fragment.");
    const content = draft.trim() || defaultCommand;
    const next: Message[] = [...messages, { role: "user", content }];
    void perform(documentSource ? "Model analizuje dokument…" : "Model przygotowuje odpowiedź…", async (signal) => {
      setAnswerInfo("");
      const answer = await post<Answer>(analyzeDocument ? "analyze" : "chat", {
        messages: next.slice(-13).map((message) => (
          message.role === "assistant" ? { ...message, content: message.content.slice(0, 5000) } : message
        )),
        preset,
        ...(analyzeDocument ? { fragments: documentSource.fragments } : { source: sourceText ?? "" }),
        language,
      }, signal);
      setMessages([...next, { role: "assistant", content: answer.text }]);
      setDraft("");
      setAnswerInfo([
        `Czas generowania ${answer.seconds.toLocaleString("pl-PL")} s.`,
        answer.limited && "Odpowiedź osiągnęła limit długości.",
        (answer.trimmed || next.length > 13) && "Model użył skróconej historii.",
      ].filter(Boolean).join(" "));
    });
  }

  function handleDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSend) event.currentTarget.form?.requestSubmit();
  }

  function readDocument(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    const kind = file.name.toLowerCase().split(".").pop() ?? "";
    if (!["pdf", "docx"].includes(kind) || file.size < 1 || file.size > 16 * 1024 * 1024) {
      setError("Wybierz plik PDF lub DOCX o rozmiarze do 16 MB.");
      return;
    }
    if (!wholeDocument && (pageFrom < 1 || pageFrom > pageTo)) {
      setError("Podaj zakres stron. Numer początkowy musi być mniejszy lub równy numerowi końcowemu.");
      return;
    }
    const singlePage = !wholeDocument && pageFrom === pageTo;
    if (!singlePage && !health?.document_ranges) {
      setError("Odczyt zakresu stron lub całego dokumentu wymaga aktualizacji Agenta AI.");
      return;
    }
    const params = new URLSearchParams({ kind, ocr: ocr ? "1" : "0" });
    if (singlePage) {
      params.set("page", String(pageFrom));
    } else if (wholeDocument) {
      params.set("whole_document", "1");
    } else {
      params.set("whole_document", "0");
      params.set("page_from", String(pageFrom));
      params.set("page_to", String(pageTo));
    }
    void perform("Odczytywanie dokumentu…", async (signal) => {
      const { page, page_from, page_to, ...data } = await post<DocumentResponse>(`document?${params}`, file, signal);
      focusDocumentCommand.current = true;
      setSource({ kind: "document", name: file.name, ...data, page_from: page_from ?? page, page_to: page_to ?? page });
      setFragment(0);
    });
  }

  function readPage(event: FormEvent) {
    event.preventDefault();
    void perform("Pobieranie strony…", async (signal) => {
      const data = await post<WebSource>("page", { url: url.trim() }, signal);
      setSource({ kind: "web", ...data });
      setFragment(0);
    });
  }

  function clear() {
    setMessages([]);
    setSource(null);
    setFile(null);
    setPageFrom(1);
    setPageTo(1);
    setWholeDocument(false);
    setOcr(false);
    setUrl("");
    setDraft("");
    setPreset("chat");
    setError("");
    setAnswerInfo("");
    if (fileInput.current) fileInput.current.value = "";
  }

  return (
    <section className={unavailable ? "ai-workspace ai-workspace-unavailable" : "ai-workspace"} aria-labelledby="ai-title">
      <header className="ai-header">
        <div>
          <h1 id="ai-title">Lokalny czat AI</h1>
          <p role="status" className="ai-connection">
            {health === null ? "Sprawdzanie połączenia…" : health.ready ? "Lokalny model gotowy" : "Lokalny model niedostępny"}
          </p>
        </div>
        <button type="button" className="ai-secondary" disabled={controlsDisabled} onClick={clear}>Wyczyść rozmowę</button>
      </header>
      {error && <p role="alert" className="ai-error">{error}</p>}
      <div className="ai-columns">
        <div className="ai-chat">
          <div className="ai-transcript" aria-label="Rozmowa" role="log" tabIndex={0}>
            {messages.length === 0 && (
              <div className="ai-empty">
                <h2>O co chcesz zapytać?</h2>
                <p>Napisz wiadomość lub dołącz dokument i wpisz polecenie.</p>
              </div>
            )}
            {messages.map((message, index) => (
              <article key={index} className={`ai-message ai-message-${message.role}`}>
                <h2>{message.role === "user" ? "Ty" : "Asystent"}</h2>
                <p>{message.content}</p>
              </article>
            ))}
            {answerInfo && <p className="ai-note" role="status">{answerInfo}</p>}
            <div ref={latest} />
          </div>
          <form className="ai-composer" onSubmit={send}>
            <label htmlFor="ai-draft">{documentSource ? "Polecenie do dokumentu" : "Wiadomość"}</label>
            <textarea ref={draftInput} id="ai-draft" rows={3} maxLength={2600} value={draft}
              onChange={(event) => setDraft(event.target.value)} disabled={controlsDisabled}
              onKeyDown={handleDraftKeyDown} enterKeyHint="send" aria-describedby="ai-compose-shortcuts"
              placeholder={documentSource
                ? (language === "en" ? "For example, summarize the document" : "Np. podsumuj dokument")
                : (language === "en" ? "Ask a question in English" : "Zadaj pytanie po polsku")} />
            <div>
              <p className="ai-note" id="ai-compose-shortcuts" hidden={controlsDisabled}>
                Enter wysyła. Shift+Enter dodaje nowy wiersz.
              </p>
              <p className="ai-progress" role="status">
                {busy && <><span className="ai-spinner" aria-hidden="true" />{busy}</>}
              </p>
            </div>
            <div className="ai-actions">
              <label>
                Zadanie
                <select value={preset} onChange={(event) => setPreset(event.target.value)} disabled={controlsDisabled}>
                  {presets.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <div className="ai-send-actions">
                <label>
                  Język rozmowy
                  <select value={language} onChange={(event) => setLanguage(event.target.value as Language)} disabled={controlsDisabled}>
                    <option value="pl" lang="pl">Polski</option>
                    <option value="en" lang="en">English</option>
                  </select>
                </label>
                <button type="submit" className="button" disabled={!canSend}>
                  {documentSource ? "Analizuj dokument" : "Wyślij"}
                </button>
              </div>
            </div>
          </form>
        </div>
        <aside className="ai-sources" aria-labelledby="ai-sources-title">
          <h2 id="ai-sources-title">Źródło do analizy</h2>
          <form className="ai-source-form" onSubmit={readDocument}>
            <label htmlFor="ai-file">Dokument PDF lub DOCX</label>
            <input ref={fileInput} id="ai-file" type="file" accept=".pdf,.docx" disabled={controlsDisabled}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setPageFrom(1);
                setPageTo(1);
              }} />
            <div className="ai-document-options">
              <label>Strona od <input type="number" min={1} max={10000} required value={pageFrom || ""}
                onChange={(event) => {
                  const page = Number(event.currentTarget.value);
                  setPageFrom(page);
                  if (event.currentTarget.validity.valid && pageTo > 0 && page > pageTo) setPageTo(page);
                }} disabled={pageRangeDisabled} /></label>
              <label>Strona do <input type="number" min={1} max={10000} required value={pageTo || ""}
                onChange={(event) => {
                  const page = Number(event.currentTarget.value);
                  setPageTo(page);
                  if (event.currentTarget.validity.valid && page < pageFrom) setPageFrom(page);
                }} disabled={pageRangeDisabled} /></label>
            </div>
            <div className="ai-document-options">
              <label className="ai-checkbox"><input type="checkbox" checked={wholeDocument}
                onChange={(event) => setWholeDocument(event.target.checked)} disabled={controlsDisabled} /> Cały dokument</label>
              <label className="ai-checkbox"><input type="checkbox" checked={ocr}
                onChange={(event) => setOcr(event.target.checked)} disabled={controlsDisabled} /> Wymuś OCR</label>
            </div>
            <button type="submit" className="ai-secondary" disabled={!file || controlsDisabled}>Dołącz dokument</button>
          </form>
          {health?.web && (
            <form className="ai-source-form" onSubmit={readPage}>
              <label htmlFor="ai-url">Publiczny adres HTTPS</label>
              <input id="ai-url" type="url" maxLength={1500} value={url} placeholder="https://"
                onChange={(event) => setUrl(event.target.value)} disabled={controlsDisabled} required />
              <p className="ai-note">Na zewnątrz wysyłane jest tylko żądanie otwarcia podanego adresu.</p>
              <button className="ai-secondary" disabled={!url.trim() || controlsDisabled}>Pobierz tekst strony</button>
            </form>
          )}
          {source && (
            <div className="ai-source-preview">
              <h3>{source.kind === "document" ? source.name : source.url}</h3>
              <p className="ai-note">
                {source.kind === "document"
                  ? `${source.page_from === source.page_to
                    ? `Strona ${source.page_from}`
                    : `Strony ${source.page_from}–${source.page_to}`} z ${source.pages}${source.ocr ? " · OCR" : ""}`
                  : source.truncated ? "Początek tekstu strony" : "Tekst strony"}
              </p>
              {source.kind === "document" && source.fragments.length > 1 && (
                <label>Podgląd fragmentu
                  <select value={fragment} disabled={controlsDisabled} onChange={(event) => setFragment(Number(event.target.value))}>
                    {source.fragments.map((_, index) => <option key={index} value={index}>{index + 1} z {source.fragments.length}</option>)}
                  </select>
                </label>
              )}
              <pre tabIndex={0}>{sourceText}</pre>
              <button className="ai-secondary" disabled={controlsDisabled}
                onClick={() => { setSource(null); setPreset("chat"); }}>Odłącz źródło</button>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
