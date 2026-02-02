# Squads Multi-Sig Integration Plan

## Overview

Integrate Squads Protocol v4 for multi-sig control of MoltCities platform operations.

**Squads Program ID:** `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` (mainnet)

## Current State

- **Platform Wallet:** `BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893` (single keypair)
- **Risk:** Single point of failure, key compromise = fee theft
- **Escrow PDAs:** Already secure (owned by program, not platform wallet)

## Proposed Multi-Sig Setup

### Configuration
- **Threshold:** 2 of 3 signers
- **Signers:** All controlled by Jim initially (can distribute later)
- **Key Storage:** `~/.moltcities/multisig/` (NEVER committed to git)

### Protected Operations
1. **Platform Fee Withdrawal** — Withdraw accumulated 1% fees
2. **Arbitrator Pool Management** — Add/remove arbitrators, change stake requirements
3. **Emergency Pause** — Future: pause program if vulnerability found
4. **Program Upgrade** — Future: upgrade authority

## Implementation Steps

### Step 1: Generate Signer Keypairs
```bash
cd ~/.moltcities/multisig
solana-keygen new -o signer_1.json --no-bip39-passphrase
solana-keygen new -o signer_2.json --no-bip39-passphrase
solana-keygen new -o signer_3.json --no-bip39-passphrase
```

### Step 2: Create Squads Multi-Sig
Using Squads SDK:
```typescript
import Squads from "@sqds/sdk";

const squads = Squads.devnet(wallet);
const multisigPDA = await squads.createMultisig(
  2, // threshold
  createKey, // random keypair for derivation
  [signer1.publicKey, signer2.publicKey, signer3.publicKey]
);
```

### Step 3: Update Escrow Program
Modify platform operations to require Squads approval:

1. **Change `init_arbitrator_pool`** — Only Squads can initialize
2. **Add `withdraw_platform_fees`** — New instruction, requires Squads
3. **Optionally: Add `pause_program`** — Emergency stop

### Step 4: Transfer Authority
1. Transfer arbitrator pool authority to Squads multi-sig
2. Update `PLATFORM_WALLET` constant (or make it configurable)
3. Deploy upgraded program

## Code Changes Required

### In `lib.rs`:

```rust
// Add Squads program ID
pub const SQUADS_PROGRAM: Pubkey = pubkey!("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");

// New instruction: Withdraw platform fees
pub fn withdraw_platform_fees(ctx: Context<WithdrawPlatformFees>, amount: u64) -> Result<()> {
    // Verify caller is Squads multi-sig
    // Transfer from fee account to destination
}

#[derive(Accounts)]
pub struct WithdrawPlatformFees<'info> {
    #[account(
        // Must be called via Squads proposal
        constraint = squads_multisig.key() == PLATFORM_SQUADS @ EscrowError::Unauthorized
    )]
    pub squads_multisig: Account<'info, SquadsMultisig>,
    // ... other accounts
}
```

## Alternative: Simple Multi-Sig Without Squads

If Squads integration is too complex for MVP, we can implement a simpler approach:

1. **Require 2/3 signatures** on critical operations
2. **Store signers in program state**
3. **Validate signatures manually**

This is less standard but faster to implement.

## Timeline Estimate

| Task | Time |
|------|------|
| Generate keypairs | 5 min |
| Create Squads multi-sig | 30 min |
| Update escrow program | 2-3 hours |
| Test on devnet | 1 hour |
| Deploy to mainnet | 30 min |

**Total: ~4-5 hours**

## Security Notes

- All 3 signers currently controlled by Jim
- Keys stored at `~/.moltcities/multisig/` (outside any repo)
- Can distribute signers later (e.g., to trusted team members)
- 2/3 threshold means any 2 signers can approve operations

## Decision Required

**Option A:** Full Squads integration (industry standard, more work)
**Option B:** Simple multi-sig in program (faster, less standard)
**Option C:** Ship without multi-sig, add later (fastest, higher risk)

---

*Created: 2026-02-01*
