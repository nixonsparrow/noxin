"""End-to-end checks inside an installed LXC, with invented document contents."""

import json
import subprocess
from io import BytesIO
from zipfile import ZipFile

from PIL import Image, ImageDraw, ImageFont

SOCKET = "/run/noxin-ai-gateway/http.sock"


def request(path, data=None):
    command = [
        "curl", "--fail-with-body", "--silent", "--show-error", "--max-time", "300",
        "--unix-socket", SOCKET, f"http://localhost/api/ai/{path}",
    ]
    if data is not None:
        content_type = "application/octet-stream" if isinstance(data, bytes) else "application/json"
        command += ["-H", "X-Noxin-Request: 1", "-H", f"Content-Type: {content_type}", "--data-binary", "@-"]
        if not isinstance(data, bytes):
            data = json.dumps(data).encode()
    result = subprocess.run(command, input=data, stdout=subprocess.PIPE, check=True)
    return json.loads(result.stdout)


def sample_pdf():
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for text in (b"UMOWA 2749", b"ANEKS 5182", b"PODPIS 3954"):
        stream = b"BT /F1 24 Tf 70 730 Td (%s) Tj ET\n" % text
        content = len(objects) + 2
        objects.extend([
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
            b"/Contents %d 0 R /Resources << /Font << /F1 3 0 R >> >> >>" % content,
            b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"endstream",
        ])
    pdf = BytesIO(b"%PDF-1.4\n")
    pdf.seek(0, 2)
    offsets = [0]
    for number, body in enumerate(objects, start=1):
        offsets.append(pdf.tell())
        pdf.write(b"%d 0 obj\n%s\nendobj\n" % (number, body))
    xref = pdf.tell()
    pdf.write(b"xref\n0 %d\n0000000000 65535 f \n" % len(offsets))
    for offset in offsets[1:]:
        pdf.write(b"%010d 00000 n \n" % offset)
    pdf.write(b"trailer << /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(offsets), xref))
    return pdf.getvalue()


def sample_docx():
    docx = BytesIO()
    with ZipFile(docx, "w") as archive:
        archive.writestr("[Content_Types].xml", """
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>""".strip())
        archive.writestr("_rels/.rels", """
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Target="word/document.xml"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"/>
</Relationships>""".strip())
        archive.writestr("word/document.xml", """
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>NOTATKA 5182</w:t></w:r></w:p></w:body>
</w:document>""".strip())
    return docx.getvalue()


def sample_scan():
    output = BytesIO()
    image = Image.new("RGB", (1000, 1200), "white")
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 54)
    ImageDraw.Draw(image).multiline_text((60, 90), "FAKTURA 6438\nKwota brutto 123,00 PLN", font=font, fill="black")
    image.save(output, format="PDF", resolution=144.0)
    return output.getvalue()


def main():
    assert request("health")["ready"], "Model się jeszcze ładuje."
    conversation = request("chat", {"messages": [{"role": "user", "content": "Przywitaj się po polsku jednym zdaniem."}]})
    assert conversation["text"]
    print(f'Rozmowa ({conversation["seconds"]} s) — {conversation["text"]}', flush=True)
    for kind, fixture, needle, expect_ocr in (
        ("pdf", sample_pdf, "2749", False),
        ("docx", sample_docx, "5182", False),
        ("pdf", sample_scan, "6438", True),
    ):
        document = request(f"document?kind={kind}&page=1&ocr=0", fixture())
        assert document["ocr"] == expect_ocr and document["page"] == 1
        source = " ".join(document["fragments"])
        assert needle in source, document
        print(f"Odczyt {kind.upper()} (OCR={expect_ocr}) działa.", flush=True)
    pdf = sample_pdf()
    selected = request("document?kind=pdf&page_from=2&page_to=3&whole_document=0", pdf)
    assert (selected["page_from"], selected["page_to"]) == (2, 3)
    assert selected["fragments"] == ["ANEKS 5182", "PODPIS 3954"], selected
    whole = request("document?kind=pdf&whole_document=1", pdf)
    assert (whole["page_from"], whole["page_to"]) == (1, 3)
    assert whole["fragments"] == ["UMOWA 2749", "ANEKS 5182", "PODPIS 3954"], whole
    print("Odczyt zakresu i całego PDF działa.", flush=True)
    invoice = request("chat", {
        "messages": [{"role": "user", "content": "Jaką kwotę brutto podano i jaki jest numer faktury?"}],
        "source": source,
        "preset": "invoice",
    })
    assert invoice["text"]
    print(f'Analiza faktury ({invoice["seconds"]} s) — {invoice["text"]}')
    summary = request("analyze", {
        "messages": [{"role": "user", "content": "Podsumuj dokument w jednym zdaniu. Podaj numery umowy i aneksu."}],
        "fragments": whole["fragments"],
    })
    assert summary["text"]
    print(f'Streszczenie PDF ({summary["seconds"]} s) — {summary["text"]}')


if __name__ == "__main__":
    main()
