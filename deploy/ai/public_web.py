"""Fetch an explicitly supplied public page without forwarding user data."""

import http.client
import ipaddress
import socket
import time
from contextlib import closing
from html.parser import HTMLParser
from urllib.parse import quote, urlsplit, urlunsplit

MAX_PAGE = 512 * 1024


class PublicPageError(ValueError):
    pass


class PageText(HTMLParser):
    hidden_tags = {"script", "style", "template", "svg", "noscript", "head"}

    def __init__(self):
        super().__init__()
        self.hidden = []
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in self.hidden_tags:
            self.hidden.append(tag)
        if tag in {"p", "main", "article", "li", "h1", "h2", "section", "br"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if self.hidden and self.hidden[-1] == tag:
            self.hidden.pop()

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def fetch_public_page(url):
    if not isinstance(url, str) or not 1 <= len(url) <= 1500 or any(
        ord(char) <= 32 or ord(char) == 127 or char in "\\?#" for char in url
    ):
        raise PublicPageError("Wklej publiczny adres HTTPS bez parametrów i fragmentu.")
    try:
        parts = urlsplit(url)
        if (parts.scheme != "https" or not parts.hostname or parts.username is not None
                or parts.port not in {None, 443} or "." not in parts.hostname.rstrip(".")):
            raise PublicPageError("Wymagany jest publiczny adres HTTPS na porcie 443.")
        host = parts.hostname.encode("idna").decode("ascii")
        addresses = socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)
        for _, _, _, _, address in addresses:
            ip = ipaddress.ip_address(address[0])
            if not ip.is_global or ip.is_multicast or ip.is_reserved:
                raise PublicPageError("Adres prowadzi poza publiczny Internet.")

        # Use the vetted IP for the socket while verifying TLS for the original host.
        connection = http.client.HTTPSConnection(host, timeout=8)
        connection._create_connection = lambda _, timeout, source_address: (
            socket.create_connection(addresses[0][4], timeout, source_address)
        )
        path = quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~")
        with closing(connection):
            connection.request("GET", path, headers={"User-Agent": "Noxin/1.0", "Accept-Encoding": "identity"})
            with connection.getresponse() as response:
                if response.status != 200:
                    raise PublicPageError("Strona nie zwróciła treści. Użyj jej bezpośredniego adresu HTTPS.")
                content_type = response.headers.get_content_type()
                if content_type not in {"text/html", "text/plain"}:
                    raise PublicPageError("Adres musi prowadzić do strony HTML lub tekstu.")
                if response.getheader("Content-Encoding", "identity") != "identity":
                    raise PublicPageError("Serwer przesłał nieobsługiwaną kompresję.")
                data = bytearray()
                deadline = time.monotonic() + 12
                while len(data) <= MAX_PAGE and time.monotonic() < deadline:
                    chunk = response.read1(min(16384, MAX_PAGE + 1 - len(data)))
                    if not chunk:
                        break
                    data.extend(chunk)
                else:
                    raise PublicPageError("Strona jest zbyt duża lub odpowiada zbyt wolno.")
                try:
                    text = data.decode(response.headers.get_content_charset() or "utf-8", errors="replace")
                except LookupError:
                    text = data.decode("utf-8", errors="replace")
    except PublicPageError:
        raise
    except (OSError, UnicodeError, ValueError, http.client.HTTPException):
        raise PublicPageError("Nie udało się połączyć z publiczną stroną HTTPS.") from None

    if content_type == "text/html":
        parser = PageText()
        parser.feed(text)
        parser.close()
        text = "".join(parser.parts)
    text = " ".join(text.split())
    if not text:
        raise PublicPageError("Strona nie zawiera dostępnego tekstu.")
    return {"url": urlunsplit(("https", host, path, "", "")),
            "text": text[:1800], "truncated": len(text) > 1800}
