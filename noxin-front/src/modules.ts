import type { ComponentType } from "react";

export interface NoxinModule {
  id: string;
  title: string;
  description: string;
  load: () => Promise<{ default: ComponentType }>;
}

export const modules: readonly NoxinModule[] = [
  {
    id: "ai",
    title: "Lokalny czat AI",
    description: "Rozmowy i analiza dokumentów na prywatnym serwerze.",
    load: () => import("./features/ai/ChatPage"),
  },
];
