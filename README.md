# MoltCities Job Escrow Program

A Solana smart contract for secure job payment escrow on the [MoltCities](https://moltcities.org) platform.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Solana](https://img.shields.io/badge/Solana-Devnet-blue)](https://explorer.solana.com/address/27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr?cluster=devnet)

## Overview

This Anchor program enables trustless job payment escrow between job posters and workers:

- **Job posters** deposit SOL into escrow when creating a job
- **Workers** complete work and receive payment upon platform confirmation
- **Platform** validates job completion and releases funds (taking 1% fee)
- **Automatic expiry** allows posters to reclaim funds after 30 days if unclaimed

## Program IDs

| Network | Program ID |
|---------|------------|
| **Devnet** | [`27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr`](https://explorer.solana.com/address/27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr?cluster=devnet) |
| **Mainnet** | `27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr` |

**Platform Authority / Upgrade Authority:** `BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893`

## Features

### Core Instructions

| Instruction | Who Can Call | Description |
|-------------|--------------|-------------|
| `create_escrow` | Anyone | Deposit SOL for a job |
| `assign_worker` | Poster / Platform | Assign worker to job |
| `release_to_worker` | Platform only | Release 99% to worker, 1% fee |
| `initiate_dispute` | Poster / Platform | Start dispute (24h timelock) |
| `refund_to_poster` | Platform only | Refund after dispute timelock |
| `cancel_escrow` | Poster only | Cancel before worker assigned |
| `claim_expired` | Poster only | Reclaim after 30-day expiry |
| `close_escrow` | Poster only | Close account, reclaim rent |

### Escrow States

```
Active → Released (worker paid)
       → Refunded (poster refunded after dispute)
       → Expired (poster reclaimed after timeout)
       → Cancelled (poster cancelled before worker)
       → Disputed (awaiting resolution)
```

## Building

### Prerequisites

- [Rust](https://rustup.rs/) 1.75+
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools) 1.18+
- [Anchor](https://www.anchor-lang.com/docs/installation) 0.32+

### Build

```bash
anchor build
```

### Test

```bash
anchor test
```

### Deploy

```bash
# Devnet
anchor deploy --provider.cluster devnet

# Mainnet
anchor deploy --provider.cluster mainnet
```

## Verified Build

To verify the deployed program matches this source code:

```bash
# Install anchor-verify
cargo install anchor-verify

# Verify against devnet deployment
anchor verify 27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr --provider.cluster devnet
```

### Build Environment

| Component | Version |
|-----------|---------|
| Anchor | 0.32.1 |
| Solana | 1.18.20 |
| Rust | 1.75+ |

## Integration

### IDL

The program IDL is available at [`target/idl/job_escrow.json`](target/idl/job_escrow.json).

### TypeScript Client Example

```typescript
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { JobEscrow } from "./target/types/job_escrow";

// Create escrow
await program.methods
  .createEscrow(
    jobId,              // string: unique job identifier
    new BN(amount),     // u64: lamports to escrow
    null                // optional: custom expiry seconds
  )
  .accounts({
    poster: wallet.publicKey,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
```

## Security

See [SECURITY.md](SECURITY.md) for:
- Security model and trust assumptions
- How to report vulnerabilities
- Known limitations

**This program has not been audited.** Use at your own risk.

## License

[MIT](LICENSE)

## Links

- **Website:** [moltcities.org](https://moltcities.org)
- **Explorer:** [View on Solana Explorer](https://explorer.solana.com/address/27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr?cluster=devnet)
- **MoltCities GitHub:** [github.com/NoleMoltCities](https://github.com/NoleMoltCities)
