//! Self-hosted randomness: pure helpers for the `EntropyChain` provider.
//!
//! Kept free of account handling so the security-relevant rules — which
//! slot hash a round uses, and how the value is derived — are unit-tested
//! directly.

use solana_sha256_hasher::{hash, hashv};

/// Why a target slot's hash cannot be used right now.
#[derive(Debug, PartialEq, Eq)]
pub enum SlotHashLookup {
    /// No produced slot at or after the target is in `SlotHashes` yet.
    NotReached,
    /// The target is older than the oldest retained entry: whichever later
    /// slot we picked now would depend on WHEN the reveal is sent, which
    /// would let the seed holder choose among outcomes. Never resolvable.
    Expired,
    /// The sysvar bytes are not a `SlotHashes` layout.
    Malformed,
}

/// Finds the hash of the FIRST produced slot at or after `target` in raw
/// `SlotHashes` sysvar data (`u64` count, then `(u64 slot, [u8; 32] hash)`
/// entries, newest first).
///
/// Skipped slots are why "first at or after" matters: if the target slot
/// produced no block, the next produced one is used. The choice is fixed by
/// the chain, not by the caller — provided the target is still inside the
/// retained window, which is what `Expired` enforces.
pub fn find_slot_hash(data: &[u8], target: u64) -> Result<(u64, [u8; 32]), SlotHashLookup> {
    const ENTRY: usize = 8 + 32;
    let count_bytes: [u8; 8] = data
        .get(0..8)
        .and_then(|b| b.try_into().ok())
        .ok_or(SlotHashLookup::Malformed)?;
    let count = u64::from_le_bytes(count_bytes) as usize;
    let needed = count
        .checked_mul(ENTRY)
        .and_then(|n| n.checked_add(8))
        .ok_or(SlotHashLookup::Malformed)?;
    if count == 0 || data.len() < needed {
        return Err(SlotHashLookup::Malformed);
    }
    let entry = |i: usize| -> (u64, [u8; 32]) {
        let at = 8 + i * ENTRY;
        let mut slot = [0u8; 8];
        slot.copy_from_slice(&data[at..at + 8]);
        let mut h = [0u8; 32];
        h.copy_from_slice(&data[at + 8..at + ENTRY]);
        (u64::from_le_bytes(slot), h)
    };
    // The window must still reach back to the target.
    if entry(count - 1).0 > target {
        return Err(SlotHashLookup::Expired);
    }
    // Newest first: walk down while slots are still >= target; the last
    // such entry is the first produced slot at or after the target.
    let mut found = None;
    for i in 0..count {
        let (slot, h) = entry(i);
        if slot < target {
            break;
        }
        found = Some((slot, h));
    }
    found.ok_or(SlotHashLookup::NotReached)
}

/// `sha256(seed)` — the hash-chain link check.
pub fn commit_of(seed: &[u8; 32]) -> [u8; 32] {
    hash(seed).to_bytes()
}

/// The round's 32-byte randomness: `sha256(DOMAIN ‖ round_id_le ‖
/// slot_hash ‖ seed)`. Binding the round id means one seed can never serve
/// two rounds even if a chain were ever reused.
pub fn entropy_value(domain: &[u8], round_id: u64, slot_hash: &[u8; 32], seed: &[u8; 32]) -> [u8; 32] {
    hashv(&[domain, &round_id.to_le_bytes(), slot_hash, seed]).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sysvar(entries: &[(u64, u8)]) -> Vec<u8> {
        let mut data = (entries.len() as u64).to_le_bytes().to_vec();
        for (slot, fill) in entries {
            data.extend_from_slice(&slot.to_le_bytes());
            data.extend_from_slice(&[*fill; 32]);
        }
        data
    }

    #[test]
    fn exact_target_is_used() {
        let data = sysvar(&[(105, 5), (104, 4), (103, 3), (102, 2)]);
        assert_eq!(find_slot_hash(&data, 103), Ok((103, [3; 32])));
    }

    #[test]
    fn skipped_target_uses_the_next_produced_slot() {
        // 103 was skipped: 104 is the first produced slot at or after it.
        let data = sysvar(&[(106, 6), (104, 4), (102, 2)]);
        assert_eq!(find_slot_hash(&data, 103), Ok((104, [4; 32])));
    }

    #[test]
    fn answer_does_not_depend_on_reveal_time() {
        // Same chain, two later windows: the target resolves identically.
        let early = sysvar(&[(105, 5), (104, 4), (102, 2)]);
        let late = sysvar(&[(140, 9), (130, 8), (105, 5), (104, 4), (102, 2)]);
        assert_eq!(find_slot_hash(&early, 103), find_slot_hash(&late, 103));
    }

    #[test]
    fn not_reached_until_a_slot_at_or_after_target_exists() {
        let data = sysvar(&[(102, 2), (101, 1)]);
        assert_eq!(find_slot_hash(&data, 103), Err(SlotHashLookup::NotReached));
    }

    #[test]
    fn expired_once_the_window_moves_past_the_target() {
        // Oldest retained entry is 104 > target 103: the answer would now
        // depend on timing, so it must be refused, not guessed.
        let data = sysvar(&[(106, 6), (105, 5), (104, 4)]);
        assert_eq!(find_slot_hash(&data, 103), Err(SlotHashLookup::Expired));
    }

    #[test]
    fn malformed_data_is_refused() {
        assert_eq!(find_slot_hash(&[], 1), Err(SlotHashLookup::Malformed));
        assert_eq!(find_slot_hash(&sysvar(&[]), 1), Err(SlotHashLookup::Malformed));
        let mut short = sysvar(&[(5, 5)]);
        short.truncate(20);
        assert_eq!(find_slot_hash(&short, 1), Err(SlotHashLookup::Malformed));
    }

    /// Cross-language known answer: the crank computes the same value
    /// locally to pick the winning entry before sending reveal+settle
    /// (apps/crank/tests/handlers.test.ts pins the same hex).
    #[test]
    fn value_known_answer_matches_the_crank() {
        let v = entropy_value(b"orb-entropy-v1", 7, &[1u8; 32], &[2u8; 32]);
        let hex: String = v.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, "da5387c4b14dda39212d5fecb05802001a7e5a0be11ff26ee0354877ce62987c");
    }

    #[test]
    fn chain_link_and_value_known_answers() {
        let seed = [7u8; 32];
        // A chain link verifies against its own hash and nothing else.
        assert_eq!(commit_of(&seed), hash(&seed).to_bytes());
        assert_ne!(commit_of(&seed), commit_of(&[8u8; 32]));
        // Every input moves the value.
        let base = entropy_value(b"d", 1, &[1; 32], &seed);
        assert_ne!(base, entropy_value(b"d", 2, &[1; 32], &seed));
        assert_ne!(base, entropy_value(b"d", 1, &[2; 32], &seed));
        assert_ne!(base, entropy_value(b"d", 1, &[1; 32], &[8; 32]));
        assert_ne!(base, entropy_value(b"e", 1, &[1; 32], &seed));
    }
}
