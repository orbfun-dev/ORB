import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Archivo (UI + display) / Geist Mono (every figure) / Instrument Serif
// (the rationed hero voice) — see the type note in styles.css.
import "@fontsource-variable/archivo";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/geist-mono/600.css";
import "@fontsource/instrument-serif/400.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";
import App from "./App";
import { WalletProviders } from "./context/WalletProviders";
import { OrbitClientProvider } from "./context/OrbitClientProvider";
import { RoundDataProvider } from "./context/RoundDataProvider";
import { ToastProvider } from "./context/ToastProvider";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { captureReferralFromUrl } from "./features/raffle/useReferralCapture";

// Banked before React mounts and before the hash router runs: a
// referral link can land on any page, and the parameter is stripped from
// the address bar once stored so it is not re-shared.
captureReferralFromUrl();

// ORE used to be a separate page at /ore-lite; it is now the "#/ore" tab
// of the shared shell. Old links (and the Vercel rewrite that still
// serves them) land here — swap the path for the hash route before the
// router reads it. Runs after the referral capture so ?ref= is banked
// first; anything else in the query string is carried over.
if (window.location.pathname.startsWith("/ore-lite")) {
  window.history.replaceState(null, "", `/${window.location.search}#/ore`);
}

// Dev diagnostics: render crashes unmount React without leaving a trace;
// keep the last errors inspectable (window.__orbitErrors).
if (import.meta.env.DEV) {
  const errors: string[] = [];
  (window as unknown as { __orbitErrors: string[] }).__orbitErrors = errors;
  window.addEventListener("error", (e) => errors.push(`${e.message}\n${e.error?.stack ?? ""}`));
  window.addEventListener("unhandledrejection", (e) =>
    errors.push(`unhandled: ${String(e.reason)}\n${e.reason?.stack ?? ""}`),
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <WalletProviders>
        <ToastProvider>
          <OrbitClientProvider>
            <RoundDataProvider>
              <App />
            </RoundDataProvider>
          </OrbitClientProvider>
        </ToastProvider>
      </WalletProviders>
    </ErrorBoundary>
  </StrictMode>,
);
