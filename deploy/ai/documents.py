"""Text extraction in a local worker whose systemd unit allows Unix sockets only."""

import os
import re
import signal
import subprocess
import tempfile
import time
from pathlib import Path
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

MAX_UPLOAD = 16 * 1024 * 1024
FRAGMENT_SIZE = 1800
MAX_DOCUMENT_TEXT = 5_000_000


class DocumentError(ValueError):
    pass


def run(*command, work, timeout=60):
    env = {**os.environ, "OMP_THREAD_LIMIT": "2", "TMPDIR": str(work)}
    with subprocess.Popen(
        command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        start_new_session=True, env=env, cwd=work,
    ) as process:
        try:
            output, _ = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate()
            raise DocumentError("Przekroczono czas przetwarzania dokumentu.") from None
        if process.returncode:
            raise DocumentError("Nie udało się odczytać dokumentu.")
    return output.decode("utf-8", errors="replace")


def check_docx(file):
    try:
        with ZipFile(file) as archive:
            files = archive.infolist()
            if len(files) > 2000 or sum(entry.file_size for entry in files) > 64 * 1024 * 1024:
                raise DocumentError("Dokument DOCX po rozpakowaniu jest zbyt duży.")
            if "word/document.xml" not in archive.namelist():
                raise DocumentError("Oczekiwano dokumentu DOCX.")
            for entry in files:
                if not entry.filename.endswith(".rels"):
                    continue
                if entry.file_size > 256 * 1024:
                    raise DocumentError("Plik relacji DOCX jest zbyt duży.")
                for relation in ElementTree.fromstring(archive.read(entry)):
                    if (
                        relation.get("TargetMode", "").lower() == "external"
                        and not relation.get("Type", "").endswith("/hyperlink")
                    ):
                        raise DocumentError("DOCX zawiera zewnętrzny zasób. Zapisz kopię bez niego.")
    except (BadZipFile, ElementTree.ParseError, RuntimeError):
        raise DocumentError("Nieprawidłowy lub zaszyfrowany plik DOCX.") from None


def ocr_page(pdf, page, work, run_command):
    selected = work / f"page-{page}.pdf"
    recognized = work / "recognized.pdf"
    run_command("pdfseparate", "-f", str(page), "-l", str(page), str(pdf),
                str(work / "page-%d.pdf"), timeout=20)
    run_command("ocrmypdf", "-l", "pol+eng", "--jobs", "1", "--force-ocr",
                "--tesseract-timeout", "60", "--optimize", "0", "--output-type", "pdf",
                str(selected), str(recognized), timeout=100)
    text = run_command("pdftotext", "-enc", "UTF-8", "-layout", str(recognized), "-", timeout=20)
    selected.unlink()
    recognized.unlink()
    return text.strip()


def split_fragments(text):
    while len(text) > FRAGMENT_SIZE:
        end = max(text.rfind("\n", FRAGMENT_SIZE // 2, FRAGMENT_SIZE),
                  text.rfind(" ", FRAGMENT_SIZE // 2, FRAGMENT_SIZE))
        end = end if end != -1 else FRAGMENT_SIZE
        yield text[:end].strip()
        text = text[end:].strip()
    if text:
        yield text


def extract(data, kind, page_from, page_to, force_ocr):
    # Leave time to return the response before the gateway's 295-second timeout.
    deadline = time.monotonic() + 285
    with tempfile.TemporaryDirectory(prefix="noxin-document-") as work:
        work = Path(work)

        def run_command(*command, timeout=60):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise DocumentError("Przekroczono czas przetwarzania dokumentu.")
            return run(*command, work=work, timeout=min(timeout, remaining))

        pdf = work / "document.pdf"
        if kind == "pdf":
            if b"%PDF-" not in data[:1024]:
                raise DocumentError("Oczekiwano pliku PDF.")
            pdf.write_bytes(data)
        else:
            docx = work / "document.docx"
            docx.write_bytes(data)
            check_docx(docx)
            run_command("libreoffice", f"-env:UserInstallation={(work / 'profile').as_uri()}",
                        "--headless", "--convert-to", "pdf", "--outdir", str(work), str(docx))
            if not pdf.exists():
                raise DocumentError("Nie udało się przekonwertować DOCX do PDF.")

        info = run_command("pdfinfo", str(pdf), timeout=15)
        match = re.search(r"^Pages:\s+(\d+)", info, re.MULTILINE)
        if not match:
            raise DocumentError("Nie można ustalić liczby stron.")
        pages = int(match[1])
        if page_to is None:
            page_to = pages
        if page_from > page_to or page_to > pages:
            raise DocumentError(f"Liczba stron dokumentu to {pages}. Wybierz zakres od 1 do {pages}.")

        fragments = []
        used_ocr = False
        total_text = 0
        batch_size = 32
        for first in range(page_from, page_to + 1, batch_size):
            last = min(first + batch_size - 1, page_to)
            if force_ocr:
                texts = [""] * (last - first + 1)
            else:
                raw = run_command("pdftotext", "-f", str(first), "-l", str(last), "-enc", "UTF-8",
                                  "-layout", str(pdf), "-", timeout=20)
                # Poppler ends each page with a form feed, including blank pages.
                texts = raw.removesuffix("\f").split("\f")
                if len(texts) != last - first + 1:
                    raise DocumentError("Nie udało się rozdzielić tekstu na strony dokumentu.")

            for page, text in enumerate(texts, start=first):
                text = text.strip()
                if not text:
                    text = ocr_page(pdf, page, work, run_command)
                    used_ocr = True
                if len(text) > 50_000:
                    raise DocumentError(f"Strona {page} zawiera zbyt dużo tekstu.")
                total_text += len(text)
                if total_text > MAX_DOCUMENT_TEXT:
                    raise DocumentError("Wybrane strony zawierają zbyt dużo tekstu. Wybierz mniejszy zakres.")
                fragments.extend(split_fragments(text))

        if not fragments:
            raise DocumentError("W wybranym zakresie stron nie znaleziono tekstu.")
        return {"pages": pages, "page": page_from, "page_from": page_from, "page_to": page_to,
                "ocr": used_ocr, "fragments": fragments}
