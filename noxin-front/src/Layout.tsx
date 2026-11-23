import { useRef, type ReactNode } from "react";
import { Link, NavLink, Outlet, useNavigation } from "react-router";

export function Layout({ fallback }: { fallback?: ReactNode }) {
  const main = useRef<HTMLElement>(null);
  const navigation = useNavigation();

  return (
    <>
      <button
        className="skip-link"
        type="button"
        onClick={() => main.current?.focus()}
      >
        Przejdź do treści
      </button>
      <header className="site-header">
        <div className="site-header-inner">
          <Link className="brand" to="/" aria-label="Noxin — strona główna">
            <span className="brand-mark" aria-hidden="true">
              N
            </span>
            Noxin
          </Link>
          <nav aria-label="Nawigacja główna">
            <NavLink className="nav-link" to="/" end>
              Moduły
            </NavLink>
          </nav>
        </div>
      </header>
      <main className="workspace" id="main-content" ref={main} tabIndex={-1}>
        {navigation.state === "loading" && !fallback && (
          <p className="loading-status" role="status">
            Wczytywanie modułu…
          </p>
        )}
        {fallback ?? <Outlet />}
      </main>
    </>
  );
}
