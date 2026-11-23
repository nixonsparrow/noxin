import { Link, type RouteObject } from "react-router";
import { Layout } from "./Layout";
import type { NoxinModule } from "./modules";

function ModuleCatalog({ modules }: { modules: readonly NoxinModule[] }) {
  return (
    <>
      <header className="catalog-header">
        <div className="catalog-art" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </div>
        <h1>Moduły</h1>
      </header>

      {modules.length > 0 ? (
        <ul className="module-grid" aria-label="Dostępne moduły">
          {modules.map((module) => (
            <li key={module.id}>
              <Link className="module-card" to={`/moduly/${module.id}`}>
                <span className="module-icon" aria-hidden="true" />
                <h2>{module.title}</h2>
                <p>{module.description}</p>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <section className="empty-catalog" aria-labelledby="empty-title">
          <span className="module-icon" aria-hidden="true" />
          <h2 id="empty-title">Brak dostępnych modułów</h2>
          <p>Dodane narzędzia pojawią się w tym katalogu.</p>
        </section>
      )}
    </>
  );
}

function RouteNotice({ title }: { title: string }) {
  return (
    <section className="route-notice">
      <h1>{title}</h1>
      <Link className="button" to="/">
        Wróć do modułów
      </Link>
    </section>
  );
}

export function createAppRoutes(
  modules: readonly NoxinModule[],
): RouteObject[] {
  return [
    {
      path: "/",
      element: <Layout />,
      hydrateFallbackElement: (
        <Layout fallback={<p role="status">Wczytywanie modułu…</p>} />
      ),
      children: [
        { index: true, element: <ModuleCatalog modules={modules} /> },
        {
          errorElement: <RouteNotice title="Nie udało się otworzyć modułu" />,
          children: modules.map((module) => ({
            path: `moduly/${module.id}/*`,
            lazy: async () => ({ Component: (await module.load()).default }),
          })),
        },
        { path: "*", element: <RouteNotice title="Nie znaleziono strony" /> },
      ],
    },
  ];
}
