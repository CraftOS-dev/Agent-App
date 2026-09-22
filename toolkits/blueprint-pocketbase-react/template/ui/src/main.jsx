/**
 * The View entry (AGENT-OWNED — edit freely to change the human UI).
 *
 * A React SPA over the same records API the agent uses: PocketBase serves the
 * records natively and the A2App adapter hooks guard the writes. Same-origin
 * writes are trusted by the adapter's origin rule, so the browser needs no
 * token. A human edits here; an agent operates the same data through A2App —
 * both see each other's changes on the next read.
 *
 * NOTE: the starter View reads the `tasks` collection, and a freshly scaffolded
 * app has NO collections (you define them as migrations under
 * pb/pb_migrations/ — see reference/blueprint.md). Until then the View shows
 * its error state; add the collection or repoint src/App.jsx at your own.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { ToastProvider } from "./toast.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
