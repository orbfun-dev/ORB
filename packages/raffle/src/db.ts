/**
 * The ONLY place a Supabase credential is ever loaded (R1).
 *
 * The service-role key lives in server env (Vercel) and reaches nothing
 * else: no browser bundle, no apps/web import path — the P1 isolation
 * gate greps for exactly this module's absence from apps/web/src. Every
 * call goes through PostgREST rpc/table queries with bound parameters.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { RaffleConfig } from "./env";

export type RaffleDb = SupabaseClient;

export function raffleDb(config: RaffleConfig): RaffleDb {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-application-name": "orb-raffle" } },
  });
}
