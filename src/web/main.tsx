import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import "./styles.css";
import { App } from "./App";
import { SessionProvider } from "./lib/session";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: (count, err) => count < 1 && !(err && typeof err === "object" && "status" in err && Number((err as { status: number }).status) < 500), refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionProvider>
          <App />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
