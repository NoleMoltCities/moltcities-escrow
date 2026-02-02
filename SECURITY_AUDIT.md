# MoltCities Job Escrow Program - Security Audit Report

**Audit Date:** February 1, 2026  
**Auditor:** Nole (OpenClaw Automated Security Analysis)  
**Program ID:** 27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr  
**Commit:** Initial Pinocchio Migration  
**Framework:** Pinocchio (raw Solana, no_std)

---

## Executive Summary

This audit examines the MoltCities job escrow program, a Solana-based escrow system for trustless job payments featuring multi-arbitrator dispute resolution and reputation tracking. The program was recently migrated from Anchor to Pinocchio for reduced binary size and compute costs.

### Overall Risk Assessment: **HIGH**

The program contains **3 critical**, **5 high**, **6 medium**, **4 low**, and **5 informational** findings. The most severe issues relate to **missing account owner validation** and **insufficient PDA verification**, which could allow complete fund drainage through account confusion attacks.

**The program is NOT ready for mainnet deployment** in its current state. Critical and high-severity issues must be resolved before any production use.

### Finding Summary

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 3 | 🔴 Must Fix |
| High | 5 | 🔴 Must Fix |
| Medium | 6 | 🟠 Should Fix |
| Low | 4 | 🟡 Consider |
| Informational | 5 | ⚪ Note |

---

## Critical Findings

### C-01: Missing Account Owner Checks Throughout All Instructions

**Severity:** Critical  
**Location:** All instruction handlers  
**Status:** 🔴 Unresolved

#### Description

The program never verifies that accounts passed to instructions are actually owned by the program before deserializing and trusting their data. In Pinocchio (and raw Solana development), this check must be performed manually—unlike Anchor which handles this automatically.

An attacker can create accounts with arbitrary data (matching the expected discriminator pattern) owned by any program, then pass them to instructions to manipulate program state.

#### Vulnerable Code Pattern

```rust
// From assign_worker.rs - NO owner check
pub fn process_assign_worker(
    accounts: &[AccountInfo],
    data: &[u8],
    _program_id: &Pubkey,  // program_id available but never used for validation!
) -> ProgramResult {
    let ctx = AssignWorkerAccounts::try_from(accounts)?;
    
    // VULNERABILITY: Loads data without verifying escrow is owned by this program
    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::load_mut(escrow_data)?;
    // ...
}
```

This pattern appears in **every single instruction handler**.

#### Impact

**Complete fund drainage.** An attacker can:
1. Create a fake escrow account (owned by system program or their own program)
2. Set the discriminator to `[0x4a, 0x6f, 0x62, 0x45, 0x73, 0x63, 0x72, 0x6f]`
3. Set `poster` field to their address
4. Set `worker` field to their address
5. Set `amount` to any value
6. Call `release_to_worker` or `claim_expired` to drain the real escrow's lamports

#### Proof of Concept

```rust
// Attacker creates fake escrow data
let mut fake_data = vec![0u8; JobEscrow::SPACE];
fake_data[..8].copy_from_slice(&JobEscrow::DISCRIMINATOR);
// Set poster = attacker, worker = attacker, amount = 1_000_000_000 (1 SOL)
// ... populate other fields

// Create account owned by system program with this data
// Pass to release_to_worker - program will happily process it
```

#### Remediation

Add owner check to every instruction that loads program accounts:

```rust
pub fn process_assign_worker(
    accounts: &[AccountInfo],
    data: &[u8],
    program_id: &Pubkey,
) -> ProgramResult {
    let ctx = AssignWorkerAccounts::try_from(accounts)?;
    
    // ADD THIS CHECK
    if ctx.escrow.owner() != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    
    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::load_mut(escrow_data)?;
    // ...
}
```

Consider creating a helper macro:

```rust
macro_rules! require_owner {
    ($account:expr, $program_id:expr) => {
        if $account.owner() != $program_id {
            return Err(ProgramError::IncorrectProgramId);
        }
    };
}
```

---

### C-02: PDA Verification Missing on Most Instructions

**Severity:** Critical  
**Location:** `assign_worker.rs`, `submit_work.rs`, `release.rs`, `dispute.rs`, `close.rs`, `arbitrator.rs` (partial)  
**Status:** 🔴 Unresolved

#### Description

Only account creation instructions (`create_escrow`, `init_reputation`, `init_arbitrator_pool`, `register_arbitrator`, `raise_dispute_case`, `update_arbitrator_accuracy`) verify that accounts match their expected PDA derivation. All other instructions accept any account without verification.

Even with owner checks added (C-01), an attacker who can create arbitrary accounts owned by the program (e.g., through a separate vulnerability or by being a previous legitimate user) can substitute accounts.

#### Vulnerable Code

```rust
// From release.rs - process_release_to_worker
// No verification that ctx.escrow is the PDA derived from job_id_hash + poster
pub fn process_release_to_worker(
    accounts: &[AccountInfo],
    _data: &[u8],
    _program_id: &Pubkey,  // Not used!
) -> ProgramResult {
    let ctx = ReleaseToWorkerAccounts::try_from(accounts)?;
    
    // Missing: Verify escrow PDA matches expected derivation
    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::load_mut(escrow_data)?;
    // ...
}
```

#### Impact

**Account substitution attacks.** An attacker could:
1. Create a legitimate escrow for Job A with 0.01 SOL
2. Complete Job A legitimately, receiving Released status
3. Substitute this account when releasing Job B (high value)
4. Since the state says "Released", close_escrow succeeds and drains funds

#### Remediation

Verify PDA derivation on every instruction, or require the job_id_hash as instruction data to re-derive and verify:

```rust
pub fn process_release_to_worker(
    accounts: &[AccountInfo],
    data: &[u8],
    program_id: &Pubkey,
) -> ProgramResult {
    let ctx = ReleaseToWorkerAccounts::try_from(accounts)?;
    
    // Load escrow to get job_id_hash and poster
    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::load_mut(escrow_data)?;
    
    // Verify PDA
    let (expected_pda, expected_bump) = find_program_address(
        &[b"escrow", &escrow.job_id_hash, &escrow.poster],
        program_id,
    );
    if ctx.escrow.key() != &expected_pda || escrow.bump != expected_bump {
        return Err(EscrowError::InvalidPda.into());
    }
    // ...
}
```

---

### C-03: Reputation PDAs Never Verified in Release/Execute Functions

**Severity:** Critical  
**Location:** `release.rs::process_release_with_reputation`, `arbitrator.rs::process_execute_dispute_resolution`  
**Status:** 🔴 Unresolved

#### Description

When updating reputation accounts during fund release, the program never verifies that the reputation PDAs are actually derived from the worker's/poster's addresses. An attacker can pass any reputation account and credit themselves.

#### Vulnerable Code

```rust
// From release.rs - process_release_with_reputation
pub fn process_release_with_reputation(
    accounts: &[AccountInfo],
    _data: &[u8],
    _program_id: &Pubkey,
) -> ProgramResult {
    let ctx = ReleaseWithReputationAccounts::try_from(accounts)?;
    
    // ... validates escrow ...
    
    // VULNERABILITY: Never verifies these are the correct reputation PDAs!
    // Update worker reputation
    {
        let worker_rep_data = &mut ctx.worker_reputation.try_borrow_mut_data()?;
        let worker_rep = AgentReputation::load_mut(worker_rep_data)?;
        worker_rep.jobs_completed += 1;  // Credits arbitrary account!
        worker_rep.total_earned += worker_payment;
        worker_rep.update_score();
    }
    // ...
}
```

#### Impact

**Reputation manipulation.** An attacker can:
1. Create their own reputation account
2. Pass it as `worker_reputation` for any job release
3. Accumulate illegitimate reputation (jobs_completed, total_earned)
4. Appear as a trusted worker to gain access to high-value jobs

This also enables reputation denial-of-service: pass a random account and the legitimate worker never gets reputation credit.

#### Remediation

Verify reputation PDAs match the worker/poster from escrow:

```rust
// Verify worker reputation PDA
let (expected_worker_rep, _) = find_program_address(
    &[b"reputation", &escrow.worker],
    program_id,
);
if ctx.worker_reputation.key() != &expected_worker_rep {
    return Err(EscrowError::InvalidPda.into());
}

// Verify poster reputation PDA  
let (expected_poster_rep, _) = find_program_address(
    &[b"reputation", &escrow.poster],
    program_id,
);
if ctx.poster_reputation.key() != &expected_poster_rep {
    return Err(EscrowError::InvalidPda.into());
}
```

---

## High Findings

### H-01: Predictable Arbitrator Selection Enables Collusion

**Severity:** High  
**Location:** `arbitrator.rs::process_raise_dispute_case`  
**Status:** 🔴 Unresolved

#### Description

The arbitrator selection algorithm uses predictable on-chain data (slot, timestamp, escrow key, initiator key, amount) to "randomly" select 5 arbitrators. An attacker who controls when they raise a dispute can predict and manipulate which arbitrators are selected.

#### Vulnerable Code

```rust
// From arbitrator.rs
let mut seed_data = [0u8; 32];
for i in 0..8 { seed_data[i] = escrow_key[i] ^ initiator_bytes[i]; }
for i in 0..8 { seed_data[8 + i] = slot_bytes[i] ^ escrow_key[16 + i]; }
for i in 0..8 { seed_data[16 + i] = ts_bytes[i] ^ initiator_bytes[16 + i]; }
for i in 0..8 { seed_data[24 + i] = amt_bytes[i] ^ escrow_key[24 + i]; }

let seed = u64::from_le_bytes(seed_data[0..8].try_into().unwrap());

let mut selected: [Pubkey; ARBITRATORS_PER_DISPUTE] = [[0u8; 32]; ARBITRATORS_PER_DISPUTE];
let mut used_indices: [usize; ARBITRATORS_PER_DISPUTE] = [usize::MAX; ARBITRATORS_PER_DISPUTE];

for i in 0..ARBITRATORS_PER_DISPUTE {
    let mut idx = ((seed.wrapping_add(i as u64).wrapping_mul(31337)) as usize) 
        % pool.arbitrator_count as usize;
    // ...
}
```

#### Impact

**Arbitration gaming.** An attacker can:
1. Register multiple colluding arbitrators (need only 3 of 5 to win)
2. Simulate the selection algorithm off-chain
3. Wait for a slot/timestamp combination that selects their arbitrators
4. Raise dispute at that exact moment
5. Win every dispute regardless of merit

#### Remediation

Use verifiable random functions (VRF) like Switchboard or Pyth entropy:

```rust
// Option 1: Use Switchboard VRF
// Requires two transactions: request randomness, then fulfill

// Option 2: Use commit-reveal scheme
// 1. Initiator commits hash of their secret
// 2. Wait for blockhash to change (new randomness)  
// 3. Initiator reveals secret
// 4. Selection uses: hash(revealed_secret || new_blockhash)

// Option 3: Use recent_slothashes sysvar (weaker but simpler)
// At minimum, include recent blockhash which validator can't predict
```

---

### H-02: Emergency Arbitration Claim Uses Wrong Deadline

**Severity:** High  
**Location:** `dispute.rs::process_claim_expired_arbitration`  
**Status:** 🔴 Unresolved

#### Description

The emergency claim for stalled arbitration uses `escrow.expires_at` (the original escrow expiry) instead of the dispute's `voting_deadline`. If arbitration is raised near the escrow's expiry, the emergency deadline could already have passed or be incorrect.

#### Vulnerable Code

```rust
// From dispute.rs
pub fn process_claim_expired_arbitration(...) -> ProgramResult {
    // ...
    require!(escrow.status == EscrowStatus::InArbitration as u8, EscrowError::NotInArbitration);
    
    // BUG: Uses escrow.expires_at instead of dispute.voting_deadline
    let emergency_deadline = escrow.expires_at + ARBITRATION_GRACE_PERIOD;
    require!(
        clock.unix_timestamp >= emergency_deadline,
        EscrowError::ArbitrationGracePeriodNotPassed
    );
    // ...
}
```

#### Impact

**Premature or impossible emergency claims:**
- If dispute raised before expiry but arbitration takes longer, poster can claim too early
- If expiry is far in the future but arbitration stalls, poster can never emergency claim
- Funds could be locked indefinitely if arbitrators don't vote

#### Remediation

Use the dispute case's voting_deadline:

```rust
pub fn process_claim_expired_arbitration(
    accounts: &[AccountInfo],
    _data: &[u8],
    _program_id: &Pubkey,
) -> ProgramResult {
    // Load dispute case too
    let dispute_data = ctx.dispute_case.try_borrow_data()?;
    let dispute = DisputeCase::load(&dispute_data)?;
    
    // Use voting_deadline not expires_at
    let emergency_deadline = dispute.voting_deadline + ARBITRATION_GRACE_PERIOD;
    require!(
        clock.unix_timestamp >= emergency_deadline,
        EscrowError::ArbitrationGracePeriodNotPassed
    );
}
```

---

### H-03: Arbitrator Pool PDA Never Verified in Pool Operations

**Severity:** High  
**Location:** `arbitrator.rs` (multiple functions)  
**Status:** 🔴 Unresolved

#### Description

Functions that modify the arbitrator pool (`register_arbitrator`, `unregister_arbitrator`, `raise_dispute_case`, `remove_arbitrator`, `close_arbitrator_account`) never verify the pool account is the correct PDA.

#### Vulnerable Code

```rust
// From arbitrator.rs - process_register_arbitrator
pub fn process_register_arbitrator(
    accounts: &[AccountInfo],
    _data: &[u8],
    program_id: &Pubkey,
) -> ProgramResult {
    let ctx = RegisterArbitratorAccounts::try_from(accounts)?;
    
    // Verifies arbitrator PDA... good
    let (expected_pda, bump) = find_program_address(
        &[b"arbitrator", ctx.agent.key()],
        program_id,
    );
    require!(ctx.arbitrator_account.key() == &expected_pda, EscrowError::InvalidPda);
    
    // BUT: Never verifies ctx.pool is the correct pool PDA!
    let pool_data = &mut ctx.pool.try_borrow_mut_data()?;
    let pool = ArbitratorPool::load_mut(pool_data)?;
    pool.add(*ctx.agent.key())?;
    // ...
}
```

#### Impact

**Fake pool injection.** An attacker could:
1. Create a fake pool account with their arbitrators
2. Pass it to `raise_dispute_case`
3. Always select their colluding arbitrators
4. Win any dispute

#### Remediation

Add pool PDA verification to all pool operations:

```rust
let (expected_pool, _) = find_program_address(&[b"arbitrator_pool_v2"], program_id);
if ctx.pool.key() != &expected_pool {
    return Err(EscrowError::InvalidPda.into());
}
```

---

### H-04: Unregister Arbitrator Returns Stake Without Burning Lamports

**Severity:** High  
**Location:** `arbitrator.rs::process_unregister_arbitrator`  
**Status:** 🔴 Unresolved

#### Description

When an arbitrator unregisters, they receive their staked lamports back. However, the account still holds lamports (for rent exemption). The stake transfer doesn't account for this properly.

#### Vulnerable Code

```rust
pub fn process_unregister_arbitrator(...) -> ProgramResult {
    // ...
    arb.is_active = 0;

    // Returns the stake amount, but account still has rent-exempt lamports
    transfer_lamports(ctx.arbitrator_account, ctx.agent, arb.stake)?;
    // Account is NOT closed - still has rent lamports
    // Can call close_arbitrator_account later to get rent back
    // Total received = stake + rent (intended?)
}
```

#### Impact

This is actually the intended behavior (unregister returns stake, close returns rent), but there's a subtle issue: if `arb.stake` is modified maliciously (via C-01/C-02), an attacker could drain more than the actual stake.

More importantly, if the account balance is less than `stake` (shouldn't happen normally), this will panic/fail.

#### Remediation

Use checked arithmetic and verify account balance:

```rust
// Verify account has enough balance
let account_balance = *ctx.arbitrator_account.try_borrow_lamports()?;
let rent = Rent::get()?.minimum_balance(ArbitratorEntry::SPACE);
let available = account_balance.saturating_sub(rent);

// Only return what's available, up to stake
let return_amount = core::cmp::min(arb.stake, available);
transfer_lamports(ctx.arbitrator_account, ctx.agent, return_amount)?;
```

---

### H-05: Integer Overflow in Reputation Score Calculation

**Severity:** High  
**Location:** `state/reputation.rs::calculate_score`  
**Status:** 🔴 Unresolved

#### Description

The reputation score calculation performs unchecked multiplication that can overflow on release builds (where `overflow-checks` is typically disabled for compute efficiency).

#### Vulnerable Code

```rust
pub fn calculate_score(&self) -> i64 {
    let base = (self.jobs_completed as i64) * 10;  // Overflow if jobs_completed > i64::MAX/10
    let dispute_bonus = (self.disputes_won as i64) * 5;
    let dispute_penalty = (self.disputes_lost as i64) * 10;
    base + dispute_bonus - dispute_penalty  // Further overflow potential
}
```

#### Impact

After ~922 quadrillion jobs completed, the score would overflow. While unrealistic through normal use, a compromised contract (via other vulns) could set `jobs_completed` to a high value, causing unexpected behavior in any code that relies on reputation scores for access control.

#### Remediation

Use saturating arithmetic:

```rust
pub fn calculate_score(&self) -> i64 {
    let base = (self.jobs_completed as i64).saturating_mul(10);
    let dispute_bonus = (self.disputes_won as i64).saturating_mul(5);
    let dispute_penalty = (self.disputes_lost as i64).saturating_mul(10);
    base.saturating_add(dispute_bonus).saturating_sub(dispute_penalty)
}
```

---

## Medium Findings

### M-01: Worker Can Submit Work Immediately Before Expiry

**Severity:** Medium  
**Location:** `submit_work.rs::process_submit_work`  
**Status:** 🟠 Unresolved

#### Description

There's no minimum time required between work submission and escrow expiry. A worker can submit work 1 second before expiry, leaving the poster insufficient time to review.

#### Impact

**Griefing attack.** Worker submits low-quality work at the last moment. Poster must either:
- Approve bad work to avoid timeout
- Wait for 24-hour review window while the escrow "expires" (state conflict)
- Initiate dispute (additional cost and time)

#### Remediation

Require minimum time between submission and expiry:

```rust
const MIN_REVIEW_BUFFER: i64 = 24 * 60 * 60; // 24 hours

// In process_submit_work:
require!(
    escrow.expires_at - clock.unix_timestamp >= MIN_REVIEW_BUFFER,
    EscrowError::InsufficientReviewTime
);
```

---

### M-02: Dispute Can Be Raised Without Worker Assignment

**Severity:** Medium  
**Location:** `arbitrator.rs::process_raise_dispute_case`  
**Status:** 🟠 Unresolved

#### Description

A dispute case can be raised on an escrow without a worker assigned. The initiator check requires `poster || worker`, and since `worker` defaults to `DEFAULT_PUBKEY`, this check passes if the initiator happens to be `[0u8; 32]` (impossible) OR if `initiator == poster`.

However, selecting arbitrators and paying dispute rent for an escrow with no work done is wasteful and could be a griefing vector.

#### Impact

Poster can waste rent creating dispute cases on their own escrows before any worker is assigned.

#### Remediation

Require worker to be assigned before dispute:

```rust
require!(escrow.has_worker(), EscrowError::NoWorkerAssigned);
```

---

### M-03: Close Escrow Doesn't Verify Dispute Case Is Closed

**Severity:** Medium  
**Location:** `close.rs::process_close_escrow`  
**Status:** 🟠 Unresolved

#### Description

When closing an escrow that went through arbitration, the dispute case account may still exist. This leaves orphaned accounts and potential state inconsistencies.

#### Impact

- Wasted rent on orphaned dispute case accounts
- Potential confusion in off-chain indexers
- `update_arbitrator_accuracy` could still be called on stale data

#### Remediation

Either require dispute case to be closed first, or close both atomically:

```rust
// Option 1: Require dispute already closed
if escrow.has_dispute_case == 1 {
    // Verify dispute_case account is zeroed/closed
    // Or add a flag to track dispute closure
}

// Option 2: Close dispute case in same instruction (more complex)
```

---

### M-04: Platform Fee Bypass via Small Amounts

**Severity:** Medium  
**Location:** `release.rs`, `arbitrator.rs`  
**Status:** 🟠 Unresolved

#### Description

The platform fee is calculated as `amount / 100`. For amounts less than 100 lamports (0.0000001 SOL), the platform fee is 0.

While the minimum escrow is 0.01 SOL (10,000,000 lamports), in dispute split scenarios:
```rust
let platform_fee = amount / 100;
let remaining = amount - platform_fee;
let worker_half = remaining / 2;
let poster_half = remaining - worker_half;
```

The math is fine, but consider: if `MIN_ESCROW_AMOUNT` is ever reduced, or for edge cases in testing, the fee calculation could round to 0.

#### Impact

Minimal at current minimums, but could allow fee avoidance if minimum is lowered.

#### Remediation

Use checked arithmetic and consider minimum fee:

```rust
const MIN_PLATFORM_FEE: u64 = 1000; // 0.000001 SOL minimum

let platform_fee = core::cmp::max(amount / 100, MIN_PLATFORM_FEE);
// Or ensure amount is always >= 100 * MIN_PLATFORM_FEE
```

---

### M-05: No Slashing for Non-Voting Arbitrators

**Severity:** Medium  
**Location:** `arbitrator.rs`  
**Status:** 🟠 Unresolved

#### Description

Arbitrators who don't vote before the deadline face no penalty. Their stake is not slashed, and they remain in the pool. This creates a free-rider problem.

#### Impact

- Disputes may not reach majority due to inactive arbitrators
- System relies on deadline expiry for resolution (suboptimal outcomes)
- No incentive for arbitrators to participate

#### Remediation

Implement slashing for non-voters:

```rust
// In finalize_dispute_case or separate instruction:
for i in 0..ARBITRATORS_PER_DISPUTE {
    if dispute.votes[i] == Vote::None as u8 {
        // Slash this arbitrator's stake partially
        // Distribute to voters or platform
    }
}
```

---

### M-06: Discriminator Values Are Human-Readable Strings

**Severity:** Medium  
**Location:** All state modules  
**Status:** 🟠 Unresolved

#### Description

Discriminators like `"JobEscro"`, `"AgentRep"`, `"ArbPool_"` are human-readable ASCII strings. This makes it easier for attackers to construct fake accounts.

#### Impact

Slightly easier account confusion attacks (attacker knows exactly what bytes to write).

#### Remediation

Use hash-based discriminators:

```rust
// Use first 8 bytes of sha256("account:JobEscrow")
pub const DISCRIMINATOR: [u8; 8] = [0x1f, 0x2e, 0x3d, 0x4c, ...];
```

---

## Low Findings

### L-01: Arbitrator Cannot Change Vote

**Severity:** Low  
**Location:** `arbitrator.rs::process_cast_arbitration_vote`  
**Status:** 🟡 Noted

#### Description

Once an arbitrator votes, they cannot change their vote even if they receive new evidence or realize they made a mistake.

#### Impact

Minor inconvenience. Arbitrators should carefully consider before voting.

#### Remediation

Allow vote changes until deadline:

```rust
// Remove this check or track "finalized" votes separately
// require!(dispute.votes[position] == Vote::None as u8, EscrowError::AlreadyVoted);

// Instead, just update:
dispute.set_vote(position, args.vote);
```

---

### L-02: No Mechanism to Extend Escrow Expiry

**Severity:** Low  
**Location:** N/A (missing feature)  
**Status:** 🟡 Noted

#### Description

Once created, an escrow's expiry cannot be extended. Long-running jobs may need more time.

#### Remediation

Add `extend_escrow` instruction allowing poster to add time (and possibly additional funds).

---

### L-03: Worker Assignment Is Irreversible

**Severity:** Low  
**Location:** `assign_worker.rs`  
**Status:** 🟡 Noted

#### Description

Once a worker is assigned, they cannot be removed or replaced, even if they become unresponsive.

#### Impact

If assigned worker disappears, poster must wait for expiry to reclaim funds.

#### Remediation

Add `remove_worker` instruction with appropriate timelock:

```rust
// Allow poster to remove worker if:
// - No work submitted AND
// - At least 7 days since assignment
```

---

### L-04: Accuracy Claim PDA Prevents Re-Claim But Not Initial Gaming

**Severity:** Low  
**Location:** `arbitrator.rs::process_update_arbitrator_accuracy`  
**Status:** 🟡 Noted

#### Description

The AccuracyClaim PDA prevents the same arbitrator from claiming accuracy twice for the same dispute. However, the timing allows gaming: an arbitrator can see the resolution before claiming accuracy.

#### Impact

Arbitrators can choose to only claim accuracy when they voted correctly, inflating their accuracy metric.

#### Remediation

Make accuracy claiming mandatory during finalization, or track in the DisputeCase directly.

---

## Informational Findings

### I-01: Unused Padding Fields Waste Rent

**Severity:** Informational  
**Location:** All state structs  
**Status:** ⚪ Noted

#### Description

Padding fields (`_padding: [u8; N]`) are used for alignment but could potentially be avoided with better struct layout.

#### Remediation

Reorder fields to minimize padding, or use `#[repr(packed)]` if alignment isn't critical.

---

### I-02: DisputeCase Reason Always Allocates 500 Bytes

**Severity:** Informational  
**Location:** `state/dispute.rs`  
**Status:** ⚪ Noted

#### Description

The `reason` field is a fixed `[u8; 500]` array, even for short reasons.

#### Remediation

Consider using a separate account for long reasons, or reduce max length.

---

### I-03: No Event Emission

**Severity:** Informational  
**Location:** All instructions  
**Status:** ⚪ Noted

#### Description

The program emits no events/logs. This makes off-chain indexing difficult.

#### Remediation

Add `sol_log_data` calls for important state changes:

```rust
use pinocchio::log::sol_log_data;

sol_log_data(&[
    b"EscrowCreated",
    &escrow.job_id_hash,
    ctx.poster.key(),
    &args.amount.to_le_bytes(),
]);
```

---

### I-04: Clock Sysvar Usage vs Slot Hashes

**Severity:** Informational  
**Location:** Multiple  
**Status:** ⚪ Noted

#### Description

The program uses `Clock::get()` for timestamps. While correct, be aware that validators have some discretion in timestamp (±25% of slot time).

#### Remediation

For time-critical operations, consider using slot numbers instead of timestamps for more predictable behavior.

---

### I-05: No Version Field in State

**Severity:** Informational  
**Location:** All state structs  
**Status:** ⚪ Noted

#### Description

State structs have no version field, making future migrations difficult.

#### Remediation

Add a version byte:

```rust
pub struct JobEscrow {
    pub version: u8,
    // ... other fields
}
```

---

## Pinocchio-Specific Concerns

### Raw Pointer Safety

The program uses unsafe pointer casts in `load()` and `load_mut()`:

```rust
Ok(unsafe { &*(data[8..].as_ptr() as *const Self) })
```

These are safe **IF**:
1. Data length is validated (✅ done)
2. Discriminator is validated (✅ done)
3. Account is owned by program (❌ **NOT DONE** - Critical)

Without owner checks, the unsafe blocks become unsound.

### Account Data Parsing

The slice-to-struct parsing is correct but relies on `#[repr(C)]` for predictable layout. This is appropriate.

### Discriminator Validation

Discriminator checks are present but should use constant-time comparison to prevent timing attacks (minor concern for on-chain code).

---

## Recommendations for Mainnet Readiness

### Must Fix Before Mainnet

1. **Add owner checks to ALL instructions** (C-01)
2. **Add PDA verification to ALL instructions** (C-02)
3. **Verify reputation PDAs** (C-03)
4. **Implement secure randomness for arbitrator selection** (H-01)
5. **Fix emergency claim deadline** (H-02)
6. **Verify pool PDA in all pool operations** (H-03)

### Should Fix Before Mainnet

1. Add minimum review buffer time (M-01)
2. Require worker for disputes (M-02)
3. Implement arbitrator slashing (M-05)
4. Use hash-based discriminators (M-06)

### Consider for Future Versions

1. Add event emission (I-03)
2. Add state versioning (I-05)
3. Allow vote changes (L-01)
4. Allow escrow extension (L-02)

---

## Testing Recommendations

1. **Fuzz testing** with arbitrary account data to verify owner/PDA checks
2. **Invariant testing** to verify no lamports can leak
3. **Economic simulation** of arbitrator collusion scenarios
4. **Timing attack analysis** on dispute creation
5. **Upgrade testing** for future state migrations

---

## Conclusion

The MoltCities escrow program demonstrates solid business logic and efficient Pinocchio usage. However, the migration from Anchor to raw Pinocchio has introduced critical security gaps that Anchor handles automatically. The missing owner checks and PDA verifications are **exploitable in production** and would allow complete fund drainage.

**Do not deploy to mainnet until Critical and High severity issues are resolved.**

After fixes are implemented, we recommend a follow-up audit focusing on:
1. Verification that all fixes are correctly implemented
2. Integration testing with the MoltCities frontend
3. Economic analysis of arbitration game theory

---

*This audit was performed by automated security analysis. For highest assurance, consider engaging a professional audit firm (OtterSec, Neodyme, Halborn) for manual review before mainnet deployment.*
