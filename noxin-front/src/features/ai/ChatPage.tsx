import { useEffect, useRef, useState, type FormEvent } from "react";
import "./chat.css";

type Message = { role: "user" | "assistant"; content: string };
type Health = { ready: boolean; web: boolean };
type DocumentSource = {
  page: number;
  pages: number;
  ocr: boolean;
  fragments: string[];
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
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [answerInfo, setAnswerInfo] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [page, setPage] = useState(1);
  const [ocr, setOcr] = useState(false);
  const [url, setUrl] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const [fragment, setFragment] = useState(0);
  const running = useRef<AbortController | null>(null);
  const latest = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sourceText = source?.kind === "document" ? source.fragments[fragment] : source?.text;

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
    if (messages.length || busy) latest.current?.scrollIntoView?.({ block: "nearest" });
  }, [messages.length, busy]);

  async function perform(label: string, operation: (signal: AbortSignal) => Promise<void>) {
    if (running.current) return;
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
    const content = draft.trim() || (preset !== "chat" ? "Przeanalizuj ten fragment." : "");
    if (!content || (!sourceText && preset !== "chat")) return;
    const next: Message[] = [...messages, { role: "user", content }];
    void perform("Model przygotowuje odpowiedź…", async (signal) => {
      setAnswerInfo("");
      const answer = await post<Answer>("chat", {
        messages: next.slice(-13).map((message) => (
          message.role === "assistant" ? { ...message, content: message.content.slice(0, 5000) } : message
        )),
        preset,
        source: sourceText ?? "",
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

  function readDocument(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    const kind = file.name.toLowerCase().split(".").pop() ?? "";
    if (!["pdf", "docx"].includes(kind) || file.size < 1 || file.size > 16 * 1024 * 1024) {
      setError("Wybierz plik PDF lub DOCX o rozmiarze do 16 MB.");
      return;
    }
    void perform("Odczytywanie dokumentu…", async (signal) => {
      const data = await post<DocumentSource>(`document?kind=${kind}&page=${page}&ocr=${Number(ocr)}`, file, signal);
      setSource({ kind: "document", name: file.name, ...data });
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
    setPage(1);
    setOcr(false);
    setUrl("");
    setDraft("");
    setPreset("chat");
    setError("");
    setAnswerInfo("");
    if (fileInput.current) fileInput.current.value = "";
  }

  return (
    <section className="ai-workspace" aria-labelledby="ai-title">
      <header className="ai-header">
        <div>
          <h1 id="ai-title">Lokalny czat AI</h1>
          <p role="status" className="ai-connection">
            {health === null ? "Sprawdzanie połączenia…" : health.ready ? "Lokalny model gotowy" : "Lokalny model niedostępny"}
          </p>
        </div>
        <button type="button" className="ai-secondary" disabled={!!busy} onClick={clear}>Wyczyść rozmowę</button>
      </header>
      {error && <p role="alert" className="ai-error">{error}</p>}
      <div className="ai-columns">
        <div className="ai-chat">
          <div className="ai-transcript" aria-label="Rozmowa" role="log" tabIndex={0}>
            {messages.length === 0 && (
              <div className="ai-empty">
                <h2>O co chcesz zapytać?</h2>
                <p>Napisz wiadomość albo dodaj fragment dokumentu. Historia jest dostępna do opuszczenia tego modułu.</p>
              </div>
            )}
            {messages.map((message, index) => (
              <article key={index} className={`ai-message ai-message-${message.role}`}>
                <h2>{message.role === "user" ? "Ty" : "Asystent"}</h2>
                <p>{message.content}</p>
              </article>
            ))}
            {(busy || answerInfo) && <p className="ai-note" role="status">{busy || answerInfo}</p>}
            <div ref={latest} />
          </div>
          <form className="ai-composer" onSubmit={send}>
            <label htmlFor="ai-draft">Wiadomość</label>
            <textarea id="ai-draft" rows={3} maxLength={2600} value={draft}
              onChange={(event) => setDraft(event.target.value)} disabled={!!busy}
              placeholder="Zadaj pytanie po polsku" />
            <div className="ai-actions">
              <label>
                Zadanie
                <select value={preset} onChange={(event) => setPreset(event.target.value)} disabled={!!busy}>
                  {presets.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <button className="button" disabled={!health?.ready || !!busy || (preset === "chat" ? !draft.trim() : !sourceText)}>
                Wyślij
              </button>
            </div>
          </form>
        </div>
        <aside className="ai-sources" aria-labelledby="ai-sources-title">
          <h2 id="ai-sources-title">Źródło do analizy</h2>
          <form className="ai-source-form" onSubmit={readDocument}>
            <label htmlFor="ai-file">Dokument PDF lub DOCX</label>
            <input ref={fileInput} id="ai-file" type="file" accept=".pdf,.docx" disabled={!!busy}
              onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPage(1); }} />
            <div className="ai-document-options">
              <label>Strona <input type="number" min={1} max={10000} required value={page || ""}
                onChange={(event) => setPage(Number(event.target.value))} disabled={!!busy} /></label>
              <label className="ai-checkbox"><input type="checkbox" checked={ocr}
                onChange={(event) => setOcr(event.target.checked)} disabled={!!busy} /> Wymuś OCR</label>
            </div>
            <button type="submit" className="ai-secondary" disabled={!file || !!busy}>Odczytaj stronę dokumentu</button>
          </form>
          {health?.web && (
            <form className="ai-source-form" onSubmit={readPage}>
              <label htmlFor="ai-url">Publiczny adres HTTPS</label>
              <input id="ai-url" type="url" maxLength={1500} value={url} placeholder="https://"
                onChange={(event) => setUrl(event.target.value)} disabled={!!busy} required />
              <p className="ai-note">Na zewnątrz wysyłane jest tylko żądanie otwarcia podanego adresu.</p>
              <button className="ai-secondary" disabled={!url.trim() || !!busy}>Pobierz tekst strony</button>
            </form>
          )}
          {source && (
            <div className="ai-source-preview">
              <h3>{source.kind === "document" ? source.name : source.url}</h3>
              <p className="ai-note">
                {source.kind === "document"
                  ? `Strona ${source.page} z ${source.pages}${source.ocr ? " · OCR" : ""}`
                  : source.truncated ? "Początek tekstu strony" : "Tekst strony"}
              </p>
              {source.kind === "document" && source.fragments.length > 1 && (
                <label>Fragment
                  <select value={fragment} disabled={!!busy} onChange={(event) => setFragment(Number(event.target.value))}>
                    {source.fragments.map((_, index) => <option key={index} value={index}>{index + 1} z {source.fragments.length}</option>)}
                  </select>
                </label>
              )}
              <pre tabIndex={0}>{sourceText}</pre>
              <button className="ai-secondary" disabled={!!busy}
                onClick={() => { setSource(null); setPreset("chat"); }}>Odłącz źródło</button>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
