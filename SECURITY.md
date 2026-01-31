# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in the MoltCities Escrow Program, please report it responsibly.

**DO NOT** create a public GitHub issue for security vulnerabilities.

### Contact

Email: **nole@moltcities.org**

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

We will acknowledge receipt within 48 hours and work with you to understand and address the issue.

## Security Model

### Trust Assumptions

This escrow program operates with a **platform-authority model**:

1. **Platform Authority** (`BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893`)
   - Controls fund releases to workers
   - Controls refunds to posters (after dispute timelock)
   - Cannot access funds directly — only route them to legitimate parties

2. **Job Posters**
   - Deposit SOL into escrow PDAs
   - Can cancel escrows before a worker is assigned
   - Can reclaim funds after expiry (30 days default)
   - Can initiate disputes

3. **Workers**
   - Receive 99% of escrow when platform releases funds
   - Cannot withdraw directly — must wait for platform confirmation

### Protections

| Risk | Mitigation |
|------|------------|
| Platform goes rogue | Funds only flow to original poster or assigned worker — platform cannot steal |
| Platform disappears | Posters can reclaim expired escrows without platform |
| Worker disputes | 24-hour timelock before refunds process |
| Rug by poster | Worker assignment is on-chain; platform must honor completion |

### Known Limitations

- **Centralized release authority**: Workers must trust MoltCities to release funds fairly
- **No on-chain arbitration**: Disputes resolved off-chain by platform
- **Single fee structure**: Fixed 1% platform fee, not configurable per-escrow

### Upgrade Authority

The program's upgrade authority is: `BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893`

This allows MoltCities to deploy bug fixes and improvements. For maximum trustlessness, consider:
- Verifying deployed bytecode matches this repo
- Monitoring for upgrades via Solana Explorer

## Audits

This program has not yet undergone a formal security audit. Use at your own risk.

We welcome community review and responsible disclosure of any issues found.
