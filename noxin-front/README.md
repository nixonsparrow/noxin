# Noxin

Noxin to katalog niezależnych narzędzi w React, TypeScript i Vite. Frontend można uruchomić samodzielnie.

## Uruchomienie

```sh
cd noxin-front
npm ci
npm run dev
```

`npm run type-check` sprawdza typy, `npm test -- --run` uruchamia testy, a `npm run build` generuje frontend w katalogu `dist`.

### Polecenia w Explorerze VS Code

Otwórz katalog główny projektu w VS Code. W menu **…** przy nagłówku **Explorer** zaznacz **NPM Scripts**. Rozwiń tę sekcję, najedź na polecenie z głównego `package.json` i kliknij **▶**. Sekcję możesz też otworzyć z palety poleceń przez `View: Open View...` → `NPM Scripts`.

- `frontend` uruchamia Vite na porcie 5173. Żądania do `/api` trafiają do lokalnego Django na porcie 8002.
- `frontend:inny-backend` pyta w terminalu o adres backendu i uruchamia Vite na porcie 5174. Moduły frontendu mogą korzystać z tego backendu przez względne adresy `/api/…`.
- `backend:django-admin` uruchamia Django. Adres panelu to `http://127.0.0.1:8002/admin/`.

**Ctrl+Shift+B** uruchamia lokalny frontend i Django równocześnie.

## Dodawanie modułu

1. Umieść kod funkcji w `src/features/<id>/`. Główny plik modułu eksportuje domyślnie komponent React.
2. Dodaj moduł do tablicy w [src/modules.ts](src/modules.ts). Nadaj mu unikalne `id` złożone z małych liter ASCII, cyfr i ewentualnych myślników, tytuł, opis oraz funkcję `load` z dynamicznym importem.

```ts
{
  id: "raporty",
  title: "Raporty",
  description: "Zestawienia miesięczne",
  load: () => import("./features/raporty/ReportsPage"),
}
```

Katalog wygeneruje kartę i adres `/#/moduly/raporty`. Kod modułu zostanie pobrany przy wejściu na jego stronę. Stan, komponenty i ewentualne połączenie z API należą do danego modułu.

Routing z hashem umożliwia bezpośrednie otwieranie adresów modułów przy statycznym hostingu. Jeśli moduł potrzebuje danych, może połączyć się z własnym API. Django może służyć jako panel administracyjny dla danych, które go wymagają.
