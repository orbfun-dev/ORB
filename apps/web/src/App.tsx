import { AppShell } from "./components/layout/AppShell";
import { StatusStrip } from "./components/layout/StatusStrip";
import { PlayPage } from "./pages/PlayPage";
import { DocsPage } from "./pages/DocsPage";
import { OrePage } from "./pages/OrePage";
import { RafflePage } from "./pages/RafflePage";
import { RaffleRulesPage } from "./pages/RaffleRulesPage";
import { useHashRoute } from "./lib/router";
import { ReferralBinder } from "./features/raffle/ReferralBinder";

export default function App() {
  const route = useHashRoute();
  return (
    <>
      <ReferralBinder />
      <AppShell route={route}>
        {route === "ore" ? (
          <OrePage />
        ) : route === "raffle" ? (
          <RafflePage />
        ) : route === "raffle-rules" ? (
          <RaffleRulesPage />
        ) : route === "docs" ? (
          <DocsPage />
        ) : (
          <PlayPage />
        )}
      </AppShell>
      {/* Round-state chrome is play-only: the docs page is static content.
          Claim actions live in the page's Your-Rewards card — no popups. */}
      {route === "play" && (
        <>
          <StatusStrip />
        </>
      )}
    </>
  );
}
