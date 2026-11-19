import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OwnersApp } from "./App";
import "@wika/react/styles.css";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OwnersApp />
  </StrictMode>,
);
