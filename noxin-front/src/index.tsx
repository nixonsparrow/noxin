import React from "react";
import ReactDOM from "react-dom/client";
import { createHashRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { createAppRoutes } from "./App";
import { modules } from "./modules";
import "./styles.css";

const router = createHashRouter(createAppRoutes(modules));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
