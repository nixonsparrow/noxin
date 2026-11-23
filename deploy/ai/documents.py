"""Text extraction in a local worker whose systemd unit allows Unix sockets only."""

import os
import re
import signal
import subprocess
import tempfile
from pathlib import Path
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

MAX_UPLOAD = 16 * 1024 * 1024
FRAGMENT_SIZE = 1800


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
            raise DocumentError("Nie udało się odczytać wybranej strony dokumentu.")
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


def extract(data, kind, page, force_ocr):
    with tempfile.TemporaryDirectory(prefix="noxin-document-") as work:
        work = Path(work)
        pdf = work / "document.pdf"
        if kind == "pdf":
            if b"%PDF-" not in data[:1024]:
                raise DocumentError("Oczekiwano pliku PDF.")
            pdf.write_bytes(data)
        else:
            docx = work / "document.docx"
            docx.write_bytes(data)
            check_docx(docx)
            run("libreoffice", f"-env:UserInstallation={(work / 'profile').as_uri()}",
                "--headless", "--convert-to", "pdf", "--outdir", str(work), str(docx), work=work)
            if not pdf.exists():
                raise DocumentError("Nie udało się przekonwertować DOCX do PDF.")

        info = run("pdfinfo", str(pdf), work=work, timeout=15)
        match = re.search(r"^Pages:\s+(\d+)", info, re.MULTILINE)
        if not match:
            raise DocumentError("Nie można ustalić liczby stron.")
        pages = int(match[1])
        if page > pages:
            raise DocumentError(f"Dokument ma {pages} stron. Wybierz stronę od 1 do {pages}.")

        text = run("pdftotext", "-f", str(page), "-l", str(page), "-enc", "UTF-8",
                   "-layout", str(pdf), "-", work=work, timeout=20).strip()
        used_ocr = force_ocr or not text
        if used_ocr:
            selected = work / f"page-{page}.pdf"
            recognized = work / "recognized.pdf"
            run("pdfseparate", "-f", str(page), "-l", str(page), str(pdf),
                str(work / "page-%d.pdf"), work=work, timeout=20)
            run("ocrmypdf", "-l", "pol+eng", "--jobs", "1", "--force-ocr",
                "--tesseract-timeout", "60", "--optimize", "0", "--output-type", "pdf",
                str(selected), str(recognized), work=work, timeout=100)
            text = run("pdftotext", "-enc", "UTF-8", "-layout", str(recognized), "-", work=work).strip()
        if not text:
            raise DocumentError("Na tej stronie nie znaleziono tekstu.")
        if len(text) > 50_000:
            raise DocumentError("Strona zawiera zbyt dużo tekstu. Podziel ją na mniejsze części.")
        fragments = []
        while len(text) > FRAGMENT_SIZE:
            end = max(text.rfind("\n", FRAGMENT_SIZE // 2, FRAGMENT_SIZE),
                      text.rfind(" ", FRAGMENT_SIZE // 2, FRAGMENT_SIZE))
            end = end if end != -1 else FRAGMENT_SIZE
            fragments.append(text[:end].strip())
            text = text[end:].strip()
        if text:
            fragments.append(text)
        return {"pages": pages, "page": page, "ocr": used_ocr, "fragments": fragments}
