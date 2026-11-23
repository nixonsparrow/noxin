import type { ComponentType } from "react";

export interface NoxinModule {
  id: string;
  title: string;
  description: string;
  load: () => Promise<{ default: ComponentType }>;
}

export const modules: readonly NoxinModule[] = [];
