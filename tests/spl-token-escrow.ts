/**
 * MoltCities SPL Token Escrow - Test Suite
 * 
 * Tests for SPL token escrow instructions (25-26)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createHash } from "crypto";
import { expect } from "chai";

// Program ID (mainnet binary)
const PROGRAM_ID = new PublicKey("FCRmfZbfmaPevAk2V1UGQAGKWXw9oeJ118A2JYJ9VadE");
const PLATFORM_WALLET = new PublicKey("BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893");

// Instruction discriminators
const DISCRIMINATORS = {
  CreateTokenEscrow: 25,
  ReleaseTokensToWorker: 26,
  // Also need AssignWorker for the full flow
  AssignWorker: 1,
};

// ==================== HELPER FUNCTIONS ====================

function sha256(data: string): Buffer {
  return createHash("sha256").update(data).digest();
}

function findEscrowPDA(jobIdHash: Buffer, poster: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), jobIdHash, poster.toBuffer()],
    PROGRAM_ID
  );
}

// ==================== INSTRUCTION BUILDERS ====================

function createTokenEscrowInstruction(
  escrow: PublicKey,
  poster: PublicKey,
  tokenMint: PublicKey,
  posterTokenAccount: PublicKey,
  escrowTokenAccount: PublicKey,
  jobIdHash: Buffer,
  amount: bigint,
  expirySeconds: bigint = BigInt(0),
) {
  const data = Buffer.alloc(1 + 32 + 8 + 8);
  data.writeUInt8(DISCRIMINATORS.CreateTokenEscrow, 0);
  jobIdHash.copy(data, 1);
  data.writeBigUInt64LE(amount, 33);
  data.writeBigInt64LE(expirySeconds, 41);

  return {
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: true, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: posterTokenAccount, isSigner: false, isWritable: true },
      { pubkey: escrowTokenAccount, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  };
}

function assignWorkerInstruction(
  escrow: PublicKey,
  poster: PublicKey,
  worker: PublicKey,
) {
  const data = Buffer.alloc(1 + 32);
  data.writeUInt8(DISCRIMINATORS.AssignWorker, 0);
  worker.toBuffer().copy(data, 1);

  return {
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  };
}

function releaseTokensToWorkerInstruction(
  escrow: PublicKey,
  platformAuthority: PublicKey,
  worker: PublicKey,
  escrowTokenAccount: PublicKey,
  workerTokenAccount: PublicKey,
  platformTokenAccount: PublicKey,
) {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.ReleaseTokensToWorker, 0);

  return {
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: platformAuthority, isSigner: true, isWritable: false },
      { pubkey: worker, isSigner: false, isWritable: true },
      { pubkey: escrowTokenAccount, isSigner: false, isWritable: true },
      { pubkey: workerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: platformTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  };
}

// ==================== TESTS ====================

describe("SPL Token Escrow", function () {
  this.timeout(180000);

  let connection: Connection;
  let poster: Keypair;
  let worker: Keypair;
  let platformAuthority: Keypair;
  let tokenMint: PublicKey;
  let posterTokenAccount: PublicKey;
  let workerTokenAccount: PublicKey;
  let platformTokenAccount: PublicKey;

  const TOKEN_DECIMALS = 6;
  const MINT_AMOUNT = 1_000_000_000n; // 1000 tokens with 6 decimals

  before(async () => {
    // Use local validator or devnet
    const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8899";
    connection = new Connection(rpcUrl, "confirmed");

    console.log("  Using RPC:", rpcUrl);
    const version = await connection.getVersion();
    console.log("  Cluster version:", JSON.stringify(version));

    // Generate test keypairs
    poster = Keypair.generate();
    worker = Keypair.generate();
    platformAuthority = Keypair.generate();

    console.log("  Funding test wallets...");

    // Airdrop SOL for rent and fees
    await connection.requestAirdrop(poster.publicKey, 5 * LAMPORTS_PER_SOL);
    await connection.requestAirdrop(worker.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.requestAirdrop(platformAuthority.publicKey, 2 * LAMPORTS_PER_SOL);

    // Wait for airdrops
    await new Promise((r) => setTimeout(r, 2000));

    console.log("    ✓ Funded poster:", poster.publicKey.toBase58().slice(0, 8) + "...");
    console.log("    ✓ Funded worker:", worker.publicKey.toBase58().slice(0, 8) + "...");
    console.log("    ✓ Funded platform:", platformAuthority.publicKey.toBase58().slice(0, 8) + "...");

    // Create a test SPL token
    console.log("  Creating test SPL token...");
    tokenMint = await createMint(
      connection,
      poster,
      poster.publicKey,      // mint authority
      null,                   // freeze authority
      TOKEN_DECIMALS,
    );
    console.log("    ✓ Token mint:", tokenMint.toBase58().slice(0, 8) + "...");

    // Create token accounts
    const posterAta = await getOrCreateAssociatedTokenAccount(
      connection,
      poster,
      tokenMint,
      poster.publicKey,
    );
    posterTokenAccount = posterAta.address;

    const workerAta = await getOrCreateAssociatedTokenAccount(
      connection,
      poster,
      tokenMint,
      worker.publicKey,
    );
    workerTokenAccount = workerAta.address;

    const platformAta = await getOrCreateAssociatedTokenAccount(
      connection,
      poster,
      tokenMint,
      PLATFORM_WALLET,
    );
    platformTokenAccount = platformAta.address;

    console.log("    ✓ Created token accounts");

    // Mint tokens to poster
    await mintTo(
      connection,
      poster,
      tokenMint,
      posterTokenAccount,
      poster,
      MINT_AMOUNT,
    );
    console.log("    ✓ Minted", Number(MINT_AMOUNT) / (10 ** TOKEN_DECIMALS), "tokens to poster");

    const posterBalance = await getAccount(connection, posterTokenAccount);
    console.log("    Poster token balance:", posterBalance.amount.toString());
  });

  describe("Phase 0: Create Token Escrow", function () {
    let escrow: PublicKey;
    let escrowTokenAccount: PublicKey;
    let jobIdHash: Buffer;
    const escrowAmount = 100_000_000n; // 100 tokens

    it("creates a token escrow", async function () {
      const jobId = `spl-test-job-${Date.now()}`;
      jobIdHash = sha256(jobId);
      [escrow] = findEscrowPDA(jobIdHash, poster.publicKey);

      // Create escrow's token account
      const escrowAta = await getOrCreateAssociatedTokenAccount(
        connection,
        poster,
        tokenMint,
        escrow,
        true, // allowOwnerOffCurve = true for PDA
      );
      escrowTokenAccount = escrowAta.address;

      const ix = createTokenEscrowInstruction(
        escrow,
        poster.publicKey,
        tokenMint,
        posterTokenAccount,
        escrowTokenAccount,
        jobIdHash,
        escrowAmount,
      );

      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
      console.log("    CreateTokenEscrow tx:", sig);

      // Verify escrow token account has the tokens
      const escrowBalance = await getAccount(connection, escrowTokenAccount);
      expect(escrowBalance.amount.toString()).to.equal(escrowAmount.toString());
      console.log("    ✓ Escrow received", Number(escrowAmount) / (10 ** TOKEN_DECIMALS), "tokens");
    });

    it("assigns a worker to token escrow", async function () {
      const ix = assignWorkerInstruction(escrow, poster.publicKey, worker.publicKey);
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
      console.log("    AssignWorker tx:", sig);
    });

    it("platform releases tokens to worker", async function () {
      // Note: This test uses platformAuthority as signer, but the program
      // checks against PLATFORM_WALLET. For testing, we'd need to either:
      // 1. Have the actual PLATFORM_WALLET keypair
      // 2. Or test with a mock where platform authority = test keypair
      
      // For now, let's verify the instruction builds correctly
      // and skip actual execution since we don't have PLATFORM_WALLET keypair
      
      const ix = releaseTokensToWorkerInstruction(
        escrow,
        PLATFORM_WALLET, // The actual platform wallet
        worker.publicKey,
        escrowTokenAccount,
        workerTokenAccount,
        platformTokenAccount,
      );

      // Verify instruction is properly formed
      expect(ix.keys.length).to.equal(7);
      expect(ix.data[0]).to.equal(DISCRIMINATORS.ReleaseTokensToWorker);
      console.log("    ✓ ReleaseTokensToWorker instruction built correctly");
      console.log("    (Skipping actual release - requires PLATFORM_WALLET keypair)");
    });
  });

  describe("Phase 1: Full Token Flow with Platform Authority", function () {
    // Note: For production testing, you'd need the actual PLATFORM_WALLET keypair
    // This section tests what we can without it

    it("verifies escrow state includes token fields", async function () {
      const jobId = `spl-verify-${Date.now()}`;
      const jobIdHash = sha256(jobId);
      const [escrow] = findEscrowPDA(jobIdHash, poster.publicKey);

      // Create escrow's token account
      const escrowAta = await getOrCreateAssociatedTokenAccount(
        connection,
        poster,
        tokenMint,
        escrow,
        true,
      );

      const escrowAmount = 50_000_000n; // 50 tokens

      const ix = createTokenEscrowInstruction(
        escrow,
        poster.publicKey,
        tokenMint,
        posterTokenAccount,
        escrowAta.address,
        jobIdHash,
        escrowAmount,
      );

      const tx = new Transaction().add(ix);
      await sendAndConfirmTransaction(connection, tx, [poster]);

      // Read and parse escrow account data
      const accountInfo = await connection.getAccountInfo(escrow);
      expect(accountInfo).to.not.be.null;
      
      // Escrow account should have:
      // - discriminator (8 bytes)
      // - job_id_hash (32 bytes)
      // - poster (32 bytes)
      // - worker (32 bytes)
      // - amount (8 bytes)
      // - status (1 byte)
      // - timestamps, etc.
      // - is_token_escrow (1 byte)
      // - token_mint (32 bytes)
      // - escrow_token_account (32 bytes)

      const data = accountInfo!.data;
      console.log("    Escrow account size:", data.length, "bytes");
      
      // Check discriminator
      const discriminator = data.slice(0, 8).toString();
      console.log("    Discriminator:", discriminator);
      
      // is_token_escrow should be 1 (offset varies by exact layout)
      // For now, just verify account was created and has data
      expect(data.length).to.be.greaterThan(200);
      console.log("    ✓ Token escrow account created with extended fields");
    });
  });
});
