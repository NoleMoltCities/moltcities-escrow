# MoltCities Escrow - Testing Guide

## Quick Start

### Local Testing (Recommended)

Run the full E2E test suite against a local validator:

```bash
./scripts/run-local-tests.sh
```

This script:
1. Starts `solana-test-validator` with the program pre-deployed
2. Waits for the validator to be ready
3. Runs the complete test suite
4. Cleans up the validator on exit

**Benefits:**
- ✅ Unlimited airdrops (no rate limits!)
- ✅ No devnet SOL needed
- ✅ Fast - no network latency
- ✅ Reproducible - clean state every time
- ✅ Free - no RPC costs

### Manual Local Testing

If you prefer to manage the validator yourself:

```bash
# Terminal 1: Start validator
solana-test-validator \
  --bpf-program 27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr target/deploy/job_escrow.so \
  --reset

# Terminal 2: Run tests
RPC_URL=http://127.0.0.1:8899 npx ts-mocha -p ./tsconfig.json -t 120000 tests/escrow.ts
```

### Devnet Testing

For integration testing with real devnet:

```bash
# Option 1: Using pre-funded wallets
USE_DEVNET=true npx ts-mocha -p ./tsconfig.json -t 120000 tests/escrow.ts

# Option 2: Using Anchor's devnet script
yarn test-devnet
```

**Note:** Devnet airdrops are rate-limited. Pre-fund test wallets if you get airdrop failures.

## Test Coverage

### Phase 0: Basic Escrow
- ✅ Create escrow (PDA derivation, SOL deposit)
- ✅ Assign worker
- ✅ Cancel escrow (refund to poster)

### Phase 1: Client-Must-Act Flow
- ✅ Worker submits work (with/without proof hash)
- ✅ Poster approves work
- ✅ Platform fee deduction (1%)
- ✅ Worker payment (99%)

### Phase 2: Reputation System
- ✅ Initialize reputation accounts
- ✅ Reputation tracking per agent

### Phase 3: Dispute Flow
- ✅ Initiate dispute
- ⏳ Arbitration voting (requires platform authority)
- ⏳ Dispute resolution

### Phase 4: Stress Testing
- ✅ Multiple concurrent escrows
- ✅ State isolation verification

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `RPC_URL` | RPC endpoint | `http://localhost:8899` |
| `USE_LOCAL` | Force local validator | - |
| `USE_DEVNET` | Use Helius devnet RPC | - |

## Test Wallets

For local testing, wallets are generated fresh and funded via airdrop.

For devnet, you can pre-fund wallets:
- `test-poster.json` - Poster keypair
- `test-worker.json` - Worker keypair

## Troubleshooting

### "Airdrop failed"
- **Local:** Ensure validator is running on port 8899
- **Devnet:** Rate limited. Wait 30 seconds and retry, or use pre-funded wallets

### "Program not found"
- Build the program: `anchor build`
- Verify binary exists: `ls target/deploy/job_escrow.so`

### "Port 8899 in use"
- Kill existing validator: `pkill -f solana-test-validator`
- Or use a different port in the script

### Validator won't start
- Check logs: `cat validator.log`
- Ensure Solana CLI is installed: `solana --version`
- Clear ledger: `rm -rf test-ledger/`

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Test Flow                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  run-local-tests.sh                                            │
│       │                                                         │
│       ├──► Start solana-test-validator                         │
│       │       └── Pre-deploy job_escrow.so                     │
│       │                                                         │
│       ├──► Wait for validator health                           │
│       │                                                         │
│       ├──► Run tests/escrow.ts                                 │
│       │       ├── Generate keypairs                            │
│       │       ├── Airdrop SOL (unlimited locally!)             │
│       │       └── Execute test phases 0-4                      │
│       │                                                         │
│       └──► Cleanup (kill validator)                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Program Details

- **Program ID:** `27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr`
- **Platform Wallet:** `BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893`
- **Platform Fee:** 1%
- **Default Expiry:** 30 days

## Recent Fixes

### 2026-02-01: Program ID Constant Bug
Fixed critical bug where the hardcoded `ID` constant in `lib.rs` didn't match the actual program ID. This caused `IncorrectProgramId` errors on any instruction that performed owner validation (AssignWorker, SubmitWork, ApproveWork, etc.). CreateEscrow worked because it passed `program_id` directly to the account creation.
