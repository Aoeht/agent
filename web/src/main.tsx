// web/src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider } from "./state/store";
import App from "./App";
import { HttpTransport } from "./lib/http";
import { MockTransport } from "./lib/mock";
import "./styles.css";

// 默认连真实后端（main.ts + Vite 代理）；VITE_TRANSPORT=mock 时用演示数据做纯前端开发
const transport =
  import.meta.env.VITE_TRANSPORT === "mock" ? new MockTransport() : new HttpTransport();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StoreProvider transport={transport}>
      <App />
    </StoreProvider>
  </StrictMode>
);
