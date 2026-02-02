/**
 * MoltCities Job Escrow - Pinocchio Test Suite
 * 
 * Tests for the migrated Pinocchio program using raw @solana/web3.js
 * (no Anchor program.methods API)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Program ID
const PROGRAM_ID = new PublicKey("27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr");
const PLATFORM_WALLET = new PublicKey("BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893");

// Instruction discriminators (single byte, from lib.rs)
const DISCRIMINATORS = {
  CreateEscrow: 0,
  AssignWorker: 1,
  SubmitWork: 2,
  ReleaseToWorker: 3,
  ApproveWork: 4,
  AutoRelease: 5,
  InitiateDispute: 6,
  RefundToPoster: 7,
  ClaimExpired: 8,
  CancelEscrow: 9,
  CloseEscrow: 10,
  InitReputation: 11,
  ReleaseWithReputation: 12,
  InitArbitratorPool: 13,
  RegisterArbitrator: 14,
  UnregisterArbitrator: 15,
  RaiseDisputeCase: 16,
  CastArbitrationVote: 17,
  FinalizeDisputeCase: 18,
  ExecuteDisputeResolution: 19,
  UpdateArbitratorAccuracy: 20,
  ClaimExpiredArbitration: 21,
  RemoveArbitrator: 22,
  CloseDisputeCase: 23,
  CloseArbitratorAccount: 24,
};

// Escrow status values (for reading state)
const EscrowStatus = {
  Active: 0,
  Released: 1,
  Refunded: 2,
  Expired: 3,
  Disputed: 4,
  Cancelled: 5,
  PendingReview: 6,
  InArbitration: 7,
  DisputeWorkerWins: 8,
  DisputePosterWins: 9,
  DisputeSplit: 10,
};

// Account discriminators for validation
const ACCOUNT_DISCRIMINATORS = {
  JobEscrow: Buffer.from([0x4a, 0x6f, 0x62, 0x45, 0x73, 0x63, 0x72, 0x6f]), // "JobEscro"
  AgentReputation: Buffer.from([0x41, 0x67, 0x65, 0x6e, 0x74, 0x52, 0x65, 0x70]), // "AgentRep"
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

function findReputationPDA(agent: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("reputation"), agent.toBuffer()],
    PROGRAM_ID
  );
}

function findArbitratorPoolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("arbitrator_pool")],
    PROGRAM_ID
  );
}

function findArbitratorPDA(agent: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("arbitrator"), agent.toBuffer()],
    PROGRAM_ID
  );
}

function findDisputeCasePDA(escrow: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("dispute"), escrow.toBuffer()],
    PROGRAM_ID
  );
}

// ==================== INSTRUCTION BUILDERS ====================

/**
 * CreateEscrow instruction
 * Data layout: [discriminator: u8, job_id_hash: [u8;32], amount: u64, expiry_seconds: i64]
 */
function createEscrowInstruction(
  escrow: PublicKey,
  poster: PublicKey,
  jobIdHash: Buffer,
  amount: bigint,
  expirySeconds: bigint = BigInt(30 * 24 * 60 * 60) // Default 30 days
): TransactionInstruction {
  const data = Buffer.alloc(1 + 32 + 8 + 8);
  let offset = 0;

  data.writeUInt8(DISCRIMINATORS.CreateEscrow, offset);
  offset += 1;

  jobIdHash.copy(data, offset);
  offset += 32;

  data.writeBigUInt64LE(amount, offset);
  offset += 8;

  data.writeBigInt64LE(expirySeconds, offset);

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * AssignWorker instruction
 * Data layout: [discriminator: u8, worker: Pubkey (32 bytes)]
 */
function assignWorkerInstruction(
  escrow: PublicKey,
  initiator: PublicKey,
  worker: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1 + 32);
  data.writeUInt8(DISCRIMINATORS.AssignWorker, 0);
  worker.toBuffer().copy(data, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: initiator, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * SubmitWork instruction
 * Data layout: [discriminator: u8, has_proof: u8, proof_hash: [u8;32] (optional)]
 */
function submitWorkInstruction(
  escrow: PublicKey,
  worker: PublicKey,
  proofHash?: Buffer
): TransactionInstruction {
  let data: Buffer;
  if (proofHash) {
    data = Buffer.alloc(1 + 1 + 32);
    data.writeUInt8(DISCRIMINATORS.SubmitWork, 0);
    data.writeUInt8(1, 1); // has_proof = true
    proofHash.copy(data, 2);
  } else {
    data = Buffer.alloc(1 + 1);
    data.writeUInt8(DISCRIMINATORS.SubmitWork, 0);
    data.writeUInt8(0, 1); // has_proof = false
  }

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: worker, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * ApproveWork instruction
 * Data layout: [discriminator: u8]
 */
function approveWorkInstruction(
  escrow: PublicKey,
  poster: PublicKey,
  worker: PublicKey,
  platform: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.ApproveWork, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: true, isWritable: false },
      { pubkey: worker, isSigner: false, isWritable: true },
      { pubkey: platform, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * CancelEscrow instruction
 * Data layout: [discriminator: u8]
 */
function cancelEscrowInstruction(
  escrow: PublicKey,
  poster: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.CancelEscrow, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: true, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * InitReputation instruction
 * Data layout: [discriminator: u8]
 */
function initReputationInstruction(
  reputation: PublicKey,
  agent: PublicKey,
  payer: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.InitReputation, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: reputation, isSigner: false, isWritable: true },
      { pubkey: agent, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * InitiateDispute instruction
 * Data layout: [discriminator: u8]
 */
function initiateDisputeInstruction(
  escrow: PublicKey,
  initiator: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.InitiateDispute, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: initiator, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

// ==================== STATE DESERIALIZERS ====================

interface EscrowState {
  jobIdHash: Buffer;
  poster: PublicKey;
  worker: PublicKey;
  amount: bigint;
  status: number;
  createdAt: bigint;
  expiresAt: bigint;
  disputeInitiatedAt: bigint;
  submittedAt: bigint;
  proofHash: Buffer;
  hasProofHash: boolean;
  disputeCase: PublicKey;
  hasDisputeCase: boolean;
  bump: number;
}

function deserializeEscrow(data: Buffer): EscrowState {
  // Skip 8-byte discriminator
  let offset = 8;

  const jobIdHash = data.subarray(offset, offset + 32);
  offset += 32;

  const poster = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const worker = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const amount = data.readBigUInt64LE(offset);
  offset += 8;

  const status = data.readUInt8(offset);
  offset += 1;

  const createdAt = data.readBigInt64LE(offset);
  offset += 8;

  const expiresAt = data.readBigInt64LE(offset);
  offset += 8;

  const disputeInitiatedAt = data.readBigInt64LE(offset);
  offset += 8;

  const submittedAt = data.readBigInt64LE(offset);
  offset += 8;

  const proofHash = data.subarray(offset, offset + 32);
  offset += 32;

  const hasProofHash = data.readUInt8(offset) !== 0;
  offset += 1;

  const disputeCase = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const hasDisputeCase = data.readUInt8(offset) !== 0;
  offset += 1;

  const bump = data.readUInt8(offset);

  return {
    jobIdHash: Buffer.from(jobIdHash),
    poster,
    worker,
    amount,
    status,
    createdAt,
    expiresAt,
    disputeInitiatedAt,
    submittedAt,
    proofHash: Buffer.from(proofHash),
    hasProofHash,
    disputeCase,
    hasDisputeCase,
    bump,
  };
}

interface ReputationState {
  agent: PublicKey;
  jobsCompleted: bigint;
  jobsPosted: bigint;
  totalEarned: bigint;
  totalSpent: bigint;
  disputesWon: bigint;
  disputesLost: bigint;
  reputationScore: bigint;
  createdAt: bigint;
  bump: number;
}

function deserializeReputation(data: Buffer): ReputationState {
  // Skip 8-byte discriminator
  let offset = 8;

  const agent = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const jobsCompleted = data.readBigUInt64LE(offset);
  offset += 8;

  const jobsPosted = data.readBigUInt64LE(offset);
  offset += 8;

  const totalEarned = data.readBigUInt64LE(offset);
  offset += 8;

  const totalSpent = data.readBigUInt64LE(offset);
  offset += 8;

  const disputesWon = data.readBigUInt64LE(offset);
  offset += 8;

  const disputesLost = data.readBigUInt64LE(offset);
  offset += 8;

  const reputationScore = data.readBigInt64LE(offset);
  offset += 8;

  const createdAt = data.readBigInt64LE(offset);
  offset += 8;

  const bump = data.readUInt8(offset);

  return {
    agent,
    jobsCompleted,
    jobsPosted,
    totalEarned,
    totalSpent,
    disputesWon,
    disputesLost,
    reputationScore,
    createdAt,
    bump,
  };
}

// ==================== TEST SUITE ====================

describe("job_escrow (Pinocchio)", () => {
  // Use devnet or local validator
  // Priority: RPC_URL env > Helius devnet > public devnet > localnet
  const HELIUS_RPC = "https://devnet.helius-rpc.com/?api-key=b7875804-ae02-4a11-845e-902e06a896c0";
  const RPC_URL = process.env.RPC_URL || 
    (process.env.USE_DEVNET === "true" ? HELIUS_RPC : "http://localhost:8899");
  
  const connection = new Connection(RPC_URL, "confirmed");
  let useDevnet = RPC_URL.includes("devnet");

  // Test wallets
  let poster: Keypair;
  let worker: Keypair;
  let arbitrator1: Keypair;
  let arbitrator2: Keypair;
  let arbitrator3: Keypair;
  let arbitrator4: Keypair;
  let arbitrator5: Keypair;

  before(async function() {
    this.timeout(60000); // 60s timeout for setup
    
    console.log(`  Using RPC: ${RPC_URL}`);
    
    // Check if cluster is reachable
    try {
      const version = await connection.getVersion();
      console.log(`  Cluster version: ${JSON.stringify(version)}`);
    } catch (e) {
      console.log(`  ⚠️  Cannot connect to ${RPC_URL}`);
      console.log(`  Trying devnet...`);
      // Fallback to devnet
      (connection as any)._rpcEndpoint = "https://api.devnet.solana.com";
      useDevnet = true;
      try {
        const version = await connection.getVersion();
        console.log(`  Connected to devnet: ${JSON.stringify(version)}`);
      } catch (e2) {
        console.log(`  ❌ Cannot connect to any cluster. Tests will fail.`);
      }
    }
    
    // Create test wallets - load pre-funded on devnet if available
    const posterKeyPath = path.join(__dirname, "..", "test-poster.json");
    const workerKeyPath = path.join(__dirname, "..", "test-worker.json");
    
    if (useDevnet && fs.existsSync(posterKeyPath) && fs.existsSync(workerKeyPath)) {
      console.log("  Loading pre-funded wallets...");
      poster = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(posterKeyPath, "utf-8")))
      );
      worker = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(workerKeyPath, "utf-8")))
      );
      console.log(`    ✓ Loaded poster: ${poster.publicKey.toBase58()}`);
      console.log(`    ✓ Loaded worker: ${worker.publicKey.toBase58()}`);
    } else {
      poster = Keypair.generate();
      worker = Keypair.generate();
    }
    
    arbitrator1 = Keypair.generate();
    arbitrator2 = Keypair.generate();
    arbitrator3 = Keypair.generate();
    arbitrator4 = Keypair.generate();
    arbitrator5 = Keypair.generate();

    // Fund wallets (skip if pre-funded devnet wallets)
    const posterBalance = await connection.getBalance(poster.publicKey);
    const workerBalance = await connection.getBalance(worker.publicKey);
    
    if (posterBalance > 0.1 * LAMPORTS_PER_SOL && workerBalance > 0.1 * LAMPORTS_PER_SOL) {
      console.log(`  Wallets already funded:`);
      console.log(`    Poster: ${posterBalance / LAMPORTS_PER_SOL} SOL`);
      console.log(`    Worker: ${workerBalance / LAMPORTS_PER_SOL} SOL`);
    } else {
      console.log("  Funding test wallets...");
      const airdropAmount = useDevnet ? 0.5 * LAMPORTS_PER_SOL : 2 * LAMPORTS_PER_SOL;
      
      for (const wallet of [poster, worker]) {
        let retries = 3;
        while (retries > 0) {
          try {
            const sig = await connection.requestAirdrop(
              wallet.publicKey,
              airdropAmount
            );
            await connection.confirmTransaction(sig, "confirmed");
            console.log(`    ✓ Funded ${wallet.publicKey.toBase58().slice(0, 8)}...`);
            break;
          } catch (e: any) {
            retries--;
            if (retries > 0) {
              console.log(`    Airdrop failed, retrying... (${retries} left)`);
              await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
              console.log(`    ⚠️ Airdrop failed for ${wallet.publicKey.toBase58().slice(0, 8)}...`);
            }
          }
        }
      }
    }
    
    // Wait for airdrops to settle
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Final balance check
    const finalPosterBalance = await connection.getBalance(poster.publicKey);
    const finalWorkerBalance = await connection.getBalance(worker.publicKey);
    console.log(`  Final balances:`);
    console.log(`    Poster: ${finalPosterBalance / LAMPORTS_PER_SOL} SOL`);
    console.log(`    Worker: ${finalWorkerBalance / LAMPORTS_PER_SOL} SOL`);
    
    if (finalPosterBalance < 0.1 * LAMPORTS_PER_SOL) {
      console.log("  ⚠️ Insufficient funds for tests. Skipping...");
      this.skip();
    }
  });

  describe("Phase 0: Basic Escrow", () => {
    const jobId = "test-job-001";
    const jobIdHash = sha256(jobId);
    let escrowPDA: PublicKey;

    it("creates an escrow", async () => {
      [escrowPDA] = findEscrowPDA(jobIdHash, poster.publicKey);
      const amount = BigInt(0.1 * LAMPORTS_PER_SOL);

      const ix = createEscrowInstruction(
        escrowPDA,
        poster.publicKey,
        jobIdHash,
        amount
      );

      const tx = new Transaction().add(ix);
      tx.feePayer = poster.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
      console.log(`    CreateEscrow tx: ${sig}`);

      // Verify escrow state
      const accountInfo = await connection.getAccountInfo(escrowPDA);
      expect(accountInfo).to.not.be.null;

      const escrow = deserializeEscrow(accountInfo!.data);
      expect(escrow.poster.equals(poster.publicKey)).to.be.true;
      expect(escrow.amount).to.equal(amount);
      expect(escrow.status).to.equal(EscrowStatus.Active);
    });

    it("assigns a worker", async () => {
      const ix = assignWorkerInstruction(
        escrowPDA,
        poster.publicKey,
        worker.publicKey
      );

      const tx = new Transaction().add(ix);
      tx.feePayer = poster.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
      console.log(`    AssignWorker tx: ${sig}`);

      const accountInfo = await connection.getAccountInfo(escrowPDA);
      const escrow = deserializeEscrow(accountInfo!.data);
      expect(escrow.worker.equals(worker.publicKey)).to.be.true;
    });

    it("cancels escrow before worker assigned", async () => {
      // Create new escrow for cancel test
      const cancelJobId = "test-cancel-001";
      const cancelJobIdHash = sha256(cancelJobId);
      const [cancelEscrowPDA] = findEscrowPDA(cancelJobIdHash, poster.publicKey);
      const amount = BigInt(0.05 * LAMPORTS_PER_SOL);

      // Create escrow
      const createIx = createEscrowInstruction(
        cancelEscrowPDA,
        poster.publicKey,
        cancelJobIdHash,
        amount
      );

      const createTx = new Transaction().add(createIx);
      createTx.feePayer = poster.publicKey;
      createTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      await sendAndConfirmTransaction(connection, createTx, [poster]);

      // Cancel escrow
      const cancelIx = cancelEscrowInstruction(cancelEscrowPDA, poster.publicKey);
      const cancelTx = new Transaction().add(cancelIx);
      cancelTx.feePayer = poster.publicKey;
      cancelTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, cancelTx, [poster]);
      console.log(`    CancelEscrow tx: ${sig}`);

      const accountInfo = await connection.getAccountInfo(cancelEscrowPDA);
      const escrow = deserializeEscrow(accountInfo!.data);
      expect(escrow.status).to.equal(EscrowStatus.Cancelled);
    });
  });

  describe("Phase 1: Client-Must-Act Flow", () => {
    const jobId = "test-job-phase1";
    const jobIdHash = sha256(jobId);
    let escrowPDA: PublicKey;

    it("creates escrow and assigns worker", async () => {
      [escrowPDA] = findEscrowPDA(jobIdHash, poster.publicKey);
      const amount = BigInt(0.1 * LAMPORTS_PER_SOL);

      // Create
      const createIx = createEscrowInstruction(
        escrowPDA,
        poster.publicKey,
        jobIdHash,
        amount
      );
      const createTx = new Transaction().add(createIx);
      createTx.feePayer = poster.publicKey;
      createTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      await sendAndConfirmTransaction(connection, createTx, [poster]);

      // Assign
      const assignIx = assignWorkerInstruction(
        escrowPDA,
        poster.publicKey,
        worker.publicKey
      );
      const assignTx = new Transaction().add(assignIx);
      assignTx.feePayer = poster.publicKey;
      assignTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      await sendAndConfirmTransaction(connection, assignTx, [poster]);

      console.log(`    Created and assigned worker for Phase 1 escrow`);
    });

    it("worker submits work", async () => {
      const proofHash = sha256("proof-of-work-data");

      const ix = submitWorkInstruction(escrowPDA, worker.publicKey, proofHash);
      const tx = new Transaction().add(ix);
      tx.feePayer = worker.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [worker]);
      console.log(`    SubmitWork tx: ${sig}`);

      const accountInfo = await connection.getAccountInfo(escrowPDA);
      const escrow = deserializeEscrow(accountInfo!.data);
      expect(escrow.status).to.equal(EscrowStatus.PendingReview);
      expect(escrow.submittedAt).to.not.equal(BigInt(0));
    });

    it("poster approves work", async () => {
      const workerBalanceBefore = await connection.getBalance(worker.publicKey);

      const ix = approveWorkInstruction(
        escrowPDA,
        poster.publicKey,
        worker.publicKey,
        PLATFORM_WALLET
      );
      const tx = new Transaction().add(ix);
      tx.feePayer = poster.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
      console.log(`    ApproveWork tx: ${sig}`);

      const accountInfo = await connection.getAccountInfo(escrowPDA);
      const escrow = deserializeEscrow(accountInfo!.data);
      expect(escrow.status).to.equal(EscrowStatus.Released);

      const workerBalanceAfter = await connection.getBalance(worker.publicKey);
      const expectedPayment = 0.1 * LAMPORTS_PER_SOL * 0.99; // 99% after 1% platform fee
      const actualPayment = workerBalanceAfter - workerBalanceBefore;
      
      // Allow some variance for rent
      expect(actualPayment).to.be.approximately(expectedPayment, 50000);
    });
  });

  describe("Phase 2: Reputation System", () => {
    it("initializes reputation for poster", async () => {
      const [reputationPDA] = findReputationPDA(poster.publicKey);

      const ix = initReputationInstruction(
        reputationPDA,
        poster.publicKey,
        poster.publicKey
      );
      const tx = new Transaction().add(ix);
      tx.feePayer = poster.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
      console.log(`    InitReputation (poster) tx: ${sig}`);

      const accountInfo = await connection.getAccountInfo(reputationPDA);
      expect(accountInfo).to.not.be.null;

      const reputation = deserializeReputation(accountInfo!.data);
      expect(reputation.agent.equals(poster.publicKey)).to.be.true;
      expect(reputation.jobsCompleted).to.equal(BigInt(0));
      expect(reputation.reputationScore).to.equal(BigInt(0));
    });

    it("initializes reputation for worker", async () => {
      const [reputationPDA] = findReputationPDA(worker.publicKey);

      const ix = initReputationInstruction(
        reputationPDA,
        worker.publicKey,
        worker.publicKey
      );
      const tx = new Transaction().add(ix);
      tx.feePayer = worker.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [worker]);
      console.log(`    InitReputation (worker) tx: ${sig}`);

      const accountInfo = await connection.getAccountInfo(reputationPDA);
      expect(accountInfo).to.not.be.null;

      const reputation = deserializeReputation(accountInfo!.data);
      expect(reputation.agent.equals(worker.publicKey)).to.be.true;
    });
  });

  describe("Phase 3: Dispute Flow", () => {
    const jobId = "test-job-dispute";
    const jobIdHash = sha256(jobId);
    let escrowPDA: PublicKey;

    it("creates escrow, assigns worker, submits work", async () => {
      [escrowPDA] = findEscrowPDA(jobIdHash, poster.publicKey);
      const amount = BigInt(0.1 * LAMPORTS_PER_SOL);

      // Create
      const createIx = createEscrowInstruction(
        escrowPDA,
        poster.publicKey,
        jobIdHash,
        amount
      );
      const createTx = new Transaction().add(createIx);
      createTx.feePayer = poster.publicKey;
      createTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      await sendAndConfirmTransaction(connection, createTx, [poster]);

      // Assign
      const assignIx = assignWorkerInstruction(
        escrowPDA,
        poster.publicKey,
        worker.publicKey
      );
      const assignTx = new Transaction().add(assignIx);
      assignTx.feePayer = poster.publicKey;
      assignTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      await sendAndConfirmTransaction(connection, assignTx, [poster]);

      // Submit (without proof for variety)
      const submitIx = submitWorkInstruction(escrowPDA, worker.publicKey);
      const submitTx = new Transaction().add(submitIx);
      submitTx.feePayer = worker.publicKey;
      submitTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      await sendAndConfirmTransaction(connection, submitTx, [worker]);

      console.log(`    Setup complete for dispute test`);
    });

    it("poster initiates dispute", async () => {
      const ix = initiateDisputeInstruction(escrowPDA, poster.publicKey);
      const tx = new Transaction().add(ix);
      tx.feePayer = poster.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
      console.log(`    InitiateDispute tx: ${sig}`);

      const accountInfo = await connection.getAccountInfo(escrowPDA);
      const escrow = deserializeEscrow(accountInfo!.data);
      expect(escrow.status).to.equal(EscrowStatus.Disputed);
      expect(escrow.disputeInitiatedAt).to.not.equal(BigInt(0));
    });
  });

  // Note: Full arbitration tests require platform authority which may not be available
  // in all test environments. The following tests show the expected patterns.

  describe("Phase 4: Multi-Escrow Stress Test", () => {
    it("handles multiple concurrent escrows", async () => {
      const escrows: PublicKey[] = [];
      const jobIds = ["stress-test-1", "stress-test-2", "stress-test-3"];

      for (const jobId of jobIds) {
        const jobIdHash = sha256(jobId);
        const [escrowPDA] = findEscrowPDA(jobIdHash, poster.publicKey);
        escrows.push(escrowPDA);

        const ix = createEscrowInstruction(
          escrowPDA,
          poster.publicKey,
          jobIdHash,
          BigInt(0.02 * LAMPORTS_PER_SOL)
        );
        const tx = new Transaction().add(ix);
        tx.feePayer = poster.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

        await sendAndConfirmTransaction(connection, tx, [poster]);
      }

      console.log(`    Created ${escrows.length} concurrent escrows`);

      // Verify all are Active
      for (const escrowPDA of escrows) {
        const accountInfo = await connection.getAccountInfo(escrowPDA);
        const escrow = deserializeEscrow(accountInfo!.data);
        expect(escrow.status).to.equal(EscrowStatus.Active);
      }
    });
  });
});
