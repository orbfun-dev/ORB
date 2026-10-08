/**
 * Auto-join submission pipeline (no-keeper design): setup (create + fund,
 * executor = the permissionless sentinel, OUR fee = one transfer on the
 * setup transaction), top-up (same terms, more deposit, executor kept as
 * the account's own — never switched) and stop (executor =
 * Pubkey.default() → the program closes the account and refunds
 * everything, fee-free). Shares the deploy pipeline's phase machine and
 * post-confirm invalidation.
 */

import { useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { OreAutomation } from "../codec";
import { ORE_AUTOJOIN, PLATFORM_FEE } from "../config";
import { platformFeeLamports } from "../fee";
import { automationPerRound, type AutomationPlan } from "../planner";
import { useOreClient } from "./useOreBoard";
import { useOreTransaction, type OreTransactionApi } from "./useOreDeploy";

export interface OreAutomateApi extends OreTransactionApi {
  /** Create the automation and fund it with the plan's exact deposit. */
  submitSetup: (plan: AutomationPlan, mask: number) => void;
  /** Add whole rounds at the account's OWN terms; executor unchanged. */
  topUp: (automation: OreAutomation, extraRounds: number) => void;
  /** Unilateral exit — full refund of balance + rent, one signature. */
  stop: (automation: OreAutomation) => void;
}

export function useOreAutomate(): OreAutomateApi {
  const tx = useOreTransaction();
  const { publicKey } = useWallet();
  const client = useOreClient();

  const submitSetup = useCallback(
    (plan: AutomationPlan, mask: number): void => {
      const executor = ORE_AUTOJOIN.executor;
      if (publicKey === null || !ORE_AUTOJOIN.enabled) return;
      void tx.run(() =>
        client.buildAutomateTransaction({
          wallet: publicKey,
          executor,
          amountPerSquare: plan.amountPerSquare,
          deposit: plan.deposit,
          fee: plan.executorFeePerRound,
          mask,
          platformFee: plan.setupFee,
        }),
      );
    },
    [client, publicKey, tx],
  );

  const topUp = useCallback(
    (automation: OreAutomation, extraRounds: number): void => {
      if (publicKey === null) return;
      const perRound = automationPerRound(automation) + automation.fee;
      const deposit = BigInt(extraRounds) * perRound;
      void tx.run(() =>
        // executor = the account's CURRENT executor: a top-up must never
        // switch it. Our 1% rides this deposit like any other.
        client.buildAutomateTransaction({
          wallet: publicKey,
          executor: automation.executor,
          amountPerSquare: automation.amount,
          deposit,
          fee: automation.fee,
          mask: automation.mask,
          reload: automation.reload,
          platformFee: platformFeeLamports(PLATFORM_FEE, deposit),
        }),
      );
    },
    [client, publicKey, tx],
  );

  const stop = useCallback(
    (automation: OreAutomation): void => {
      if (publicKey === null) return;
      void tx.run(() => client.buildStopAutomationTransaction(publicKey, automation));
    },
    [client, publicKey, tx],
  );

  return { ...tx, submitSetup, topUp, stop };
}
