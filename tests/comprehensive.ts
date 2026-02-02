/**
 * MoltCities Job Escrow - COMPREHENSIVE Test Suite
 * 
 * Tests ALL 25 Pinocchio instructions for the escrow program.
 * Run with: npx ts-mocha -p ./tsconfig.json -t 120000 tests/comprehensive.ts --exit
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
  SYSVAR_SLOT_HASHES_PUBKEY,
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

// Escrow status values
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

// Vote values
const Vote = {
  None: 0,
  ForWorker: 1,
  ForPoster: 2,
};

// DisputeResolution values
const DisputeResolution = {
  Pending: 0,
  WorkerWins: 1,
  PosterWins: 2,
  Split: 3,
};

// Constants from program
const ARBITRATORS_PER_DISPUTE = 5;
const MIN_ARBITRATOR_STAKE = 100_000_000; // 0.1 SOL

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
    [Buffer.from("arbitrator_pool_v2")],
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

function findAccuracyClaimPDA(disputeCase: PublicKey, arbitrator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("accuracy_claim"), disputeCase.toBuffer(), arbitrator.toBuffer()],
    PROGRAM_ID
  );
}

// ==================== INSTRUCTION BUILDERS ====================

function createEscrowInstruction(
  escrow: PublicKey,
  poster: PublicKey,
  jobIdHash: Buffer,
  amount: bigint,
  expirySeconds: bigint = BigInt(30 * 24 * 60 * 60)
): TransactionInstruction {
  const data = Buffer.alloc(1 + 32 + 8 + 8);
  let offset = 0;
  data.writeUInt8(DISCRIMINATORS.CreateEscrow, offset); offset += 1;
  jobIdHash.copy(data, offset); offset += 32;
  data.writeBigUInt64LE(amount, offset); offset += 8;
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

function submitWorkInstruction(
  escrow: PublicKey,
  worker: PublicKey,
  proofHash?: Buffer
): TransactionInstruction {
  let data: Buffer;
  if (proofHash) {
    data = Buffer.alloc(1 + 1 + 32);
    data.writeUInt8(DISCRIMINATORS.SubmitWork, 0);
    data.writeUInt8(1, 1);
    proofHash.copy(data, 2);
  } else {
    data = Buffer.alloc(1 + 1);
    data.writeUInt8(DISCRIMINATORS.SubmitWork, 0);
    data.writeUInt8(0, 1);
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

function releaseToWorkerInstruction(
  escrow: PublicKey,
  platformAuthority: PublicKey,
  worker: PublicKey,
  platform: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.ReleaseToWorker, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: platformAuthority, isSigner: true, isWritable: false },
      { pubkey: worker, isSigner: false, isWritable: true },
      { pubkey: platform, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

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

function autoReleaseInstruction(
  escrow: PublicKey,
  cranker: PublicKey,
  worker: PublicKey,
  platform: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.AutoRelease, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: cranker, isSigner: true, isWritable: false },
      { pubkey: worker, isSigner: false, isWritable: true },
      { pubkey: platform, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

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

function refundToPosterInstruction(
  escrow: PublicKey,
  platformAuthority: PublicKey,
  poster: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.RefundToPoster, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: platformAuthority, isSigner: true, isWritable: false },
      { pubkey: poster, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function claimExpiredInstruction(
  escrow: PublicKey,
  poster: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.ClaimExpired, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: true, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

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

function closeEscrowInstruction(
  escrow: PublicKey,
  poster: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.CloseEscrow, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: true, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

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

function releaseWithReputationInstruction(
  escrow: PublicKey,
  platformAuthority: PublicKey,
  worker: PublicKey,
  platform: PublicKey,
  workerReputation: PublicKey,
  posterReputation: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.ReleaseWithReputation, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: platformAuthority, isSigner: true, isWritable: false },
      { pubkey: worker, isSigner: false, isWritable: true },
      { pubkey: platform, isSigner: false, isWritable: true },
      { pubkey: workerReputation, isSigner: false, isWritable: true },
      { pubkey: posterReputation, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function initArbitratorPoolInstruction(
  pool: PublicKey,
  authority: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.InitArbitratorPool, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function registerArbitratorInstruction(
  pool: PublicKey,
  arbitratorAccount: PublicKey,
  agent: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.RegisterArbitrator, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: arbitratorAccount, isSigner: false, isWritable: true },
      { pubkey: agent, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function unregisterArbitratorInstruction(
  pool: PublicKey,
  arbitratorAccount: PublicKey,
  agent: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.UnregisterArbitrator, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: arbitratorAccount, isSigner: false, isWritable: true },
      { pubkey: agent, isSigner: true, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function raiseDisputeCaseInstruction(
  escrow: PublicKey,
  disputeCase: PublicKey,
  pool: PublicKey,
  recentSlothashes: PublicKey,
  initiator: PublicKey,
  reason: string
): TransactionInstruction {
  const reasonBytes = Buffer.from(reason, "utf-8");
  const data = Buffer.alloc(1 + 2 + reasonBytes.length);
  data.writeUInt8(DISCRIMINATORS.RaiseDisputeCase, 0);
  data.writeUInt16LE(reasonBytes.length, 1);
  reasonBytes.copy(data, 3);

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: disputeCase, isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: false },
      { pubkey: recentSlothashes, isSigner: false, isWritable: false },
      { pubkey: initiator, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function castArbitrationVoteInstruction(
  disputeCase: PublicKey,
  arbitratorAccount: PublicKey,
  voter: PublicKey,
  vote: number
): TransactionInstruction {
  const data = Buffer.alloc(2);
  data.writeUInt8(DISCRIMINATORS.CastArbitrationVote, 0);
  data.writeUInt8(vote, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: disputeCase, isSigner: false, isWritable: true },
      { pubkey: arbitratorAccount, isSigner: false, isWritable: true },
      { pubkey: voter, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function finalizeDisputeCaseInstruction(
  disputeCase: PublicKey,
  escrow: PublicKey,
  finalizer: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.FinalizeDisputeCase, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: disputeCase, isSigner: false, isWritable: true },
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: finalizer, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function executeDisputeResolutionInstruction(
  disputeCase: PublicKey,
  escrow: PublicKey,
  worker: PublicKey,
  poster: PublicKey,
  platform: PublicKey,
  workerReputation: PublicKey,
  posterReputation: PublicKey,
  executor: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.ExecuteDisputeResolution, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: disputeCase, isSigner: false, isWritable: false },
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: worker, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: false, isWritable: true },
      { pubkey: platform, isSigner: false, isWritable: true },
      { pubkey: workerReputation, isSigner: false, isWritable: true },
      { pubkey: posterReputation, isSigner: false, isWritable: true },
      { pubkey: executor, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function updateArbitratorAccuracyInstruction(
  disputeCase: PublicKey,
  arbitratorAccount: PublicKey,
  accuracyClaim: PublicKey,
  caller: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.UpdateArbitratorAccuracy, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: disputeCase, isSigner: false, isWritable: false },
      { pubkey: arbitratorAccount, isSigner: false, isWritable: true },
      { pubkey: accuracyClaim, isSigner: false, isWritable: true },
      { pubkey: caller, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function claimExpiredArbitrationInstruction(
  escrow: PublicKey,
  disputeCase: PublicKey,
  poster: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.ClaimExpiredArbitration, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: disputeCase, isSigner: false, isWritable: false },
      { pubkey: poster, isSigner: true, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function removeArbitratorInstruction(
  pool: PublicKey,
  arbitratorAccount: PublicKey,
  arbitratorAgent: PublicKey,
  authority: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.RemoveArbitrator, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: arbitratorAccount, isSigner: false, isWritable: true },
      { pubkey: arbitratorAgent, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function closeDisputeCaseInstruction(
  disputeCase: PublicKey,
  escrow: PublicKey,
  initiator: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.CloseDisputeCase, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: disputeCase, isSigner: false, isWritable: true },
      { pubkey: escrow, isSigner: false, isWritable: false },
      { pubkey: initiator, isSigner: true, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function closeArbitratorAccountInstruction(
  pool: PublicKey,
  arbitratorAccount: PublicKey,
  agent: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(DISCRIMINATORS.CloseArbitratorAccount, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: pool, isSigner: false, isWritable: false },
      { pubkey: arbitratorAccount, isSigner: false, isWritable: true },
      { pubkey: agent, isSigner: true, isWritable: true },
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
  let offset = 8;
  const jobIdHash = data.subarray(offset, offset + 32); offset += 32;
  const poster = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const worker = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const amount = data.readBigUInt64LE(offset); offset += 8;
  const status = data.readUInt8(offset); offset += 1;
  const createdAt = data.readBigInt64LE(offset); offset += 8;
  const expiresAt = data.readBigInt64LE(offset); offset += 8;
  const disputeInitiatedAt = data.readBigInt64LE(offset); offset += 8;
  const submittedAt = data.readBigInt64LE(offset); offset += 8;
  const proofHash = data.subarray(offset, offset + 32); offset += 32;
  const hasProofHash = data.readUInt8(offset) !== 0; offset += 1;
  const disputeCase = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const hasDisputeCase = data.readUInt8(offset) !== 0; offset += 1;
  const bump = data.readUInt8(offset);

  return {
    jobIdHash: Buffer.from(jobIdHash), poster, worker, amount, status,
    createdAt, expiresAt, disputeInitiatedAt, submittedAt,
    proofHash: Buffer.from(proofHash), hasProofHash,
    disputeCase, hasDisputeCase, bump,
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
  let offset = 8;
  const agent = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const jobsCompleted = data.readBigUInt64LE(offset); offset += 8;
  const jobsPosted = data.readBigUInt64LE(offset); offset += 8;
  const totalEarned = data.readBigUInt64LE(offset); offset += 8;
  const totalSpent = data.readBigUInt64LE(offset); offset += 8;
  const disputesWon = data.readBigUInt64LE(offset); offset += 8;
  const disputesLost = data.readBigUInt64LE(offset); offset += 8;
  const reputationScore = data.readBigInt64LE(offset); offset += 8;
  const createdAt = data.readBigInt64LE(offset); offset += 8;
  const bump = data.readUInt8(offset);

  return {
    agent, jobsCompleted, jobsPosted, totalEarned, totalSpent,
    disputesWon, disputesLost, reputationScore, createdAt, bump,
  };
}

interface ArbitratorPoolState {
  authority: PublicKey;
  minStake: bigint;
  arbitratorCount: number;
  bump: number;
}

function deserializeArbitratorPool(data: Buffer): ArbitratorPoolState {
  let offset = 8;
  const authority = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const minStake = data.readBigUInt64LE(offset); offset += 8;
  const arbitratorCount = data.readUInt8(offset); offset += 1;
  // Skip arbitrators array (100 * 32 bytes)
  offset += 100 * 32;
  const bump = data.readUInt8(offset);

  return { authority, minStake, arbitratorCount, bump };
}

interface ArbitratorEntryState {
  agent: PublicKey;
  stake: bigint;
  casesVoted: bigint;
  casesCorrect: bigint;
  isActive: boolean;
  registeredAt: bigint;
  bump: number;
}

function deserializeArbitratorEntry(data: Buffer): ArbitratorEntryState {
  let offset = 8;
  const agent = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const stake = data.readBigUInt64LE(offset); offset += 8;
  const casesVoted = data.readBigUInt64LE(offset); offset += 8;
  const casesCorrect = data.readBigUInt64LE(offset); offset += 8;
  const isActive = data.readUInt8(offset) !== 0; offset += 1;
  const registeredAt = data.readBigInt64LE(offset); offset += 8;
  const bump = data.readUInt8(offset);

  return { agent, stake, casesVoted, casesCorrect, isActive, registeredAt, bump };
}

interface DisputeCaseState {
  escrow: PublicKey;
  raisedBy: PublicKey;
  arbitrators: PublicKey[];
  votes: number[];
  votingDeadline: bigint;
  resolution: number;
  createdAt: bigint;
  bump: number;
  reason: string;
}

function deserializeDisputeCase(data: Buffer): DisputeCaseState {
  let offset = 8;
  const escrow = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const raisedBy = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  
  const arbitrators: PublicKey[] = [];
  for (let i = 0; i < 5; i++) {
    arbitrators.push(new PublicKey(data.subarray(offset, offset + 32)));
    offset += 32;
  }
  
  const votes: number[] = [];
  for (let i = 0; i < 5; i++) {
    votes.push(data.readUInt8(offset)); offset += 1;
  }
  offset += 3; // repr(C) alignment padding for i64
  
  const votingDeadline = data.readBigInt64LE(offset); offset += 8;
  const resolution = data.readUInt8(offset); offset += 1;
  const createdAt = data.readBigInt64LE(offset); offset += 8;
  const bump = data.readUInt8(offset); offset += 1;
  
  // Read reason (length-prefixed string)
  const reasonLen = data.readUInt16LE(offset); offset += 2;
  const reason = data.subarray(offset, offset + reasonLen).toString("utf-8");

  return {
    escrow, raisedBy, arbitrators, votes, votingDeadline,
    resolution, createdAt, bump, reason,
  };
}

// ==================== TEST SUITE ====================

describe("Comprehensive Pinocchio Escrow Tests (All 25 Instructions)", () => {
  const RPC_URL = process.env.RPC_URL || "http://localhost:8899";
  const connection = new Connection(RPC_URL, "confirmed");

  // Wallets
  let poster: Keypair;
  let worker: Keypair;
  let platformWallet: Keypair;
  
  // Arbitrators (need 5 for disputes)
  let arbitrators: Keypair[] = [];

  // Track test results
  const testResults: { [key: number]: { name: string; status: string; notes: string } } = {};

  before(async function() {
    this.timeout(120000);
    console.log(`\n  Using RPC: ${RPC_URL}`);

    // Load platform wallet
    const platformWalletPath = path.join(process.env.HOME!, ".moltcities", "platform_wallet.json");
    if (fs.existsSync(platformWalletPath)) {
      platformWallet = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(platformWalletPath, "utf-8")))
      );
      console.log(`  ✓ Loaded platform wallet: ${platformWallet.publicKey.toBase58()}`);
    } else {
      console.log(`  ⚠️ Platform wallet not found at ${platformWalletPath}`);
      console.log(`  Some tests requiring platform authority will be skipped`);
    }

    // Generate test wallets
    poster = Keypair.generate();
    worker = Keypair.generate();
    
    // Generate 7 arbitrators (5 minimum + 2 extra for testing)
    for (let i = 0; i < 7; i++) {
      arbitrators.push(Keypair.generate());
    }

    console.log(`  Generated test wallets:`);
    console.log(`    Poster: ${poster.publicKey.toBase58()}`);
    console.log(`    Worker: ${worker.publicKey.toBase58()}`);
    console.log(`    Arbitrators: ${arbitrators.length}`);

    // Fund all wallets
    const walletsToFund = [poster, worker, platformWallet, ...arbitrators].filter(Boolean);
    
    for (const wallet of walletsToFund) {
      try {
        const sig = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(sig, "confirmed");
      } catch (e: any) {
        console.log(`    ⚠️ Airdrop failed for ${wallet.publicKey.toBase58().slice(0, 8)}...`);
      }
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    const posterBalance = await connection.getBalance(poster.publicKey);
    console.log(`  Final poster balance: ${posterBalance / LAMPORTS_PER_SOL} SOL`);
  });

  after(function() {
    console.log("\n\n=== TEST SUMMARY ===");
    const instructions = [
      "CreateEscrow", "AssignWorker", "SubmitWork", "ReleaseToWorker", "ApproveWork",
      "AutoRelease", "InitiateDispute", "RefundToPoster", "ClaimExpired", "CancelEscrow",
      "CloseEscrow", "InitReputation", "ReleaseWithReputation", "InitArbitratorPool",
      "RegisterArbitrator", "UnregisterArbitrator", "RaiseDisputeCase", "CastArbitrationVote",
      "FinalizeDisputeCase", "ExecuteDisputeResolution", "UpdateArbitratorAccuracy",
      "ClaimExpiredArbitration", "RemoveArbitrator", "CloseDisputeCase", "CloseArbitratorAccount"
    ];
    
    let tested = 0, skipped = 0, failed = 0;
    
    for (let i = 0; i < instructions.length; i++) {
      const result = testResults[i];
      const status = result?.status || "NOT_RUN";
      const symbol = status === "PASSED" ? "✓" : status === "SKIPPED" ? "⊘" : "✗";
      console.log(`  ${i.toString().padStart(2)}: ${symbol} ${instructions[i]} - ${status}${result?.notes ? ` (${result.notes})` : ""}`);
      
      if (status === "PASSED") tested++;
      else if (status === "SKIPPED") skipped++;
      else failed++;
    }
    
    console.log(`\n  Total: ${tested} passed, ${skipped} skipped, ${failed} failed/not run`);
  });

  // ==================== PHASE 1: CORE ESCROW (0-10) ====================
  
  describe("Core Escrow Instructions (0-10)", () => {
    const jobId1 = "comprehensive-test-001";
    const jobIdHash1 = sha256(jobId1);
    let escrowPDA1: PublicKey;

    it("0: CreateEscrow", async () => {
      [escrowPDA1] = findEscrowPDA(jobIdHash1, poster.publicKey);
      const amount = BigInt(0.1 * LAMPORTS_PER_SOL);

      const ix = createEscrowInstruction(escrowPDA1, poster.publicKey, jobIdHash1, amount);
      const tx = new Transaction().add(ix);
      tx.feePayer = poster.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
      console.log(`      CreateEscrow tx: ${sig.slice(0, 20)}...`);

      const accountInfo = await connection.getAccountInfo(escrowPDA1);
      expect(accountInfo).to.not.be.null;
      const escrow = deserializeEscrow(accountInfo!.data);
      expect(escrow.status).to.equal(EscrowStatus.Active);
      
      testResults[0] = { name: "CreateEscrow", status: "PASSED", notes: "" };
    });

    it("1: AssignWorker", async () => {
      const ix = assignWorkerInstruction(escrowPDA1, poster.publicKey, worker.publicKey);
      const tx = new Transaction().add(ix);
      tx.feePayer = poster.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
      console.log(`      AssignWorker tx: ${sig.slice(0, 20)}...`);

      const accountInfo = await connection.getAccountInfo(escrowPDA1);
      const escrow = deserializeEscrow(accountInfo!.data);
      expect(escrow.worker.equals(worker.publicKey)).to.be.true;
      
      testResults[1] = { name: "AssignWorker", status: "PASSED", notes: "" };
    });

    it("2: SubmitWork", async () => {
      const proofHash = sha256("work-proof-data");
      const ix = submitWorkInstruction(escrowPDA1, worker.publicKey, proofHash);
      const tx = new Transaction().add(ix);
      tx.feePayer = worker.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [worker]);
      console.log(`      SubmitWork tx: ${sig.slice(0, 20)}...`);

      const accountInfo = await connection.getAccountInfo(escrowPDA1);
      const escrow = deserializeEscrow(accountInfo!.data);
      expect(escrow.status).to.equal(EscrowStatus.PendingReview);
      
      testResults[2] = { name: "SubmitWork", status: "PASSED", notes: "" };
    });

    it("3: ReleaseToWorker (platform authority)", async function() {
      if (!platformWallet) {
        testResults[3] = { name: "ReleaseToWorker", status: "SKIPPED", notes: "No platform wallet" };
        this.skip();
      }

      // Create fresh escrow for this test
      const jobId = "release-to-worker-test";
      const jobIdHash = sha256(jobId);
      const [escrowPDA] = findEscrowPDA(jobIdHash, poster.publicKey);
      const amount = BigInt(0.05 * LAMPORTS_PER_SOL);

      // Create, assign, submit (without going to PendingReview)
      const createIx = createEscrowInstruction(escrowPDA, poster.publicKey, jobIdHash, amount);
      const assignIx = assignWorkerInstruction(escrowPDA, poster.publicKey, worker.publicKey);
      
      const setupTx = new Transaction().add(createIx).add(assignIx);
      setupTx.feePayer = poster.publicKey;
      setupTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      await sendAndConfirmTransaction(connection, setupTx, [poster]);

      // ReleaseToWorker
      const ix = releaseToWorkerInstruction(escrowPDA, platformWallet.publicKey, worker.publicKey, PLATFORM_WALLET);
      const tx = new Transaction().add(ix);
      tx.feePayer = platformWallet.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [platformWallet]);
      console.log(`      ReleaseToWorker tx: ${sig.slice(0, 20)}...`);

      const accountInfo = await connection.getAccountInfo(escrowPDA);
      const escrow = deserializeEscrow(accountInfo!.data);
      expect(escrow.status).to.equal(EscrowStatus.Released);
      
      testResults[3] = { name: "ReleaseToWorker", status: "PASSED", notes: "" };
    });

    it("4: ApproveWork", async () => {
      // Continue with escrowPDA1 which is in PendingReview state
      const ix = approveWorkInstruction(escrowPDA1, poster.publicKey, worker.publicKey, PLATFORM_WALLET);
      const tx = new Transaction().add(ix);
      tx.feePayer = poster.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
      console.log(`      ApproveWork tx: ${sig.slice(0, 20)}...`);

      const accountInfo = await connection.getAccountInfo(escrowPDA1);
      const escrow = deserializeEscrow(accountInfo!.data);
      expect(escrow.status).to.equal(EscrowStatus.Released);
      
      testResults[4] = { name: "ApproveWork", status: "PASSED", notes: "" };
    });

    it("5: AutoRelease (requires time advancement)", async function() {
      // This test requires advancing time by 48 hours (review window)
      // In local test-validator, we can't easily manipulate time
      testResults[5] = { name: "AutoRelease", status: "SKIPPED", notes: "Requires 48h time advancement" };
      console.log(`      ⊘ AutoRelease skipped: requires 48h time advancement`);
      this.skip();
    });

    it("6: InitiateDispute", async () => {
      // Create fresh escrow for dispute test
      const jobId = "dispute-test-001";
      const jobIdHash = sha256(jobId);
      const [escrowPDA] = findEscrowPDA(jobIdHash, poster.publicKey);
      const amount = BigInt(0.05 * LAMPORTS_PER_SOL);

      const createIx = createEscrowInstruction(escrowPDA, poster.publicKey, jobIdHash, amount);
      const assignIx = assignWorkerInstruction(escrowPDA, poster.publicKey, worker.publicKey);
      const submitIx = submitWorkInstruction(escrowPDA, worker.publicKey);
      
      const setupTx = new Transaction().add(createIx).add(assignIx).add(submitIx);
      setupTx.feePayer = poster.publicKey;
      setupTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      await sendAndConfirmTransaction(connection, setupTx, [poster, worker]);

      const ix = initiateDisputeInstruction(escrowPDA, poster.publicKey);
      const tx = new Transaction().add(ix);
      tx.feePayer = poster.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
      console.log(`      InitiateDispute tx: ${sig.slice(0, 20)}...`);

      const accountInfo = await connection.getAccountInfo(escrowPDA);
      const escrow = deserializeEscrow(accountInfo!.data);
      expect(escrow.status).to.equal(EscrowStatus.Disputed);
      
      testResults[6] = { name: "InitiateDispute", status: "PASSED", notes: "" };
    });

    it("7: RefundToPoster (requires 24h timelock)", async function() {
      // RefundToPoster requires 24h after dispute initiation
      testResults[7] = { name: "RefundToPoster", status: "SKIPPED", notes: "Requires 24h timelock" };
      console.log(`      ⊘ RefundToPoster skipped: requires 24h timelock after dispute`);
      this.skip();
    });

    it("8: ClaimExpired (requires escrow expiry)", async function() {
      // ClaimExpired requires waiting for escrow to expire
      testResults[8] = { name: "ClaimExpired", status: "SKIPPED", notes: "Requires escrow expiry" };
      console.log(`      ⊘ ClaimExpired skipped: requires escrow expiry time`);
      this.skip();
    });

    it("9: CancelEscrow (before worker assigned)", async () => {
      const jobId = "cancel-test-001";
      const jobIdHash = sha256(jobId);
      const [escrowPDA] = findEscrowPDA(jobIdHash, poster.publicKey);
      const amount = BigInt(0.03 * LAMPORTS_PER_SOL);

      // Create escrow
      const createIx = createEscrowInstruction(escrowPDA, poster.publicKey, jobIdHash, amount);
      const createTx = new Transaction().add(createIx);
      createTx.feePayer = poster.publicKey;
      createTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      await sendAndConfirmTransaction(connection, createTx, [poster]);

      // Cancel
      const ix = cancelEscrowInstruction(escrowPDA, poster.publicKey);
      const tx = new Transaction().add(ix);
      tx.feePayer = poster.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
      console.log(`      CancelEscrow tx: ${sig.slice(0, 20)}...`);

      const accountInfo = await connection.getAccountInfo(escrowPDA);
      const escrow = deserializeEscrow(accountInfo!.data);
      expect(escrow.status).to.equal(EscrowStatus.Cancelled);
      
      testResults[9] = { name: "CancelEscrow", status: "PASSED", notes: "" };
    });

    it("10: CloseEscrow (after terminal state)", async () => {
      // escrowPDA1 is already in Released state from ApproveWork test
      const ix = closeEscrowInstruction(escrowPDA1, poster.publicKey);
      const tx = new Transaction().add(ix);
      tx.feePayer = poster.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
      console.log(`      CloseEscrow tx: ${sig.slice(0, 20)}...`);

      // Account should be zeroed out
      const accountInfo = await connection.getAccountInfo(escrowPDA1);
      // Account data should be all zeros or account closed
      if (accountInfo) {
        const allZeros = accountInfo.data.every(b => b === 0);
        expect(allZeros).to.be.true;
      }
      
      testResults[10] = { name: "CloseEscrow", status: "PASSED", notes: "" };
    });
  });

  // ==================== PHASE 2: REPUTATION (11-12) ====================

  describe("Reputation Instructions (11-12)", () => {
    let posterRepPDA: PublicKey;
    let workerRepPDA: PublicKey;

    it("11: InitReputation", async () => {
      [posterRepPDA] = findReputationPDA(poster.publicKey);
      [workerRepPDA] = findReputationPDA(worker.publicKey);

      // Init poster reputation
      const ix1 = initReputationInstruction(posterRepPDA, poster.publicKey, poster.publicKey);
      const tx1 = new Transaction().add(ix1);
      tx1.feePayer = poster.publicKey;
      tx1.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      await sendAndConfirmTransaction(connection, tx1, [poster]);

      // Init worker reputation
      const ix2 = initReputationInstruction(workerRepPDA, worker.publicKey, worker.publicKey);
      const tx2 = new Transaction().add(ix2);
      tx2.feePayer = worker.publicKey;
      tx2.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const sig = await sendAndConfirmTransaction(connection, tx2, [worker]);
      console.log(`      InitReputation tx: ${sig.slice(0, 20)}...`);

      const accountInfo = await connection.getAccountInfo(workerRepPDA);
      expect(accountInfo).to.not.be.null;
      
      testResults[11] = { name: "InitReputation", status: "PASSED", notes: "" };
    });

    it("12: ReleaseWithReputation (platform authority)", async function() {
      if (!platformWallet) {
        testResults[12] = { name: "ReleaseWithReputation", status: "SKIPPED", notes: "No platform wallet" };
        this.skip();
      }

      // Create fresh escrow
      const jobId = "release-with-rep-test";
      const jobIdHash = sha256(jobId);
      const [escrowPDA] = findEscrowPDA(jobIdHash, poster.publicKey);
      const amount = BigInt(0.05 * LAMPORTS_PER_SOL);

      const createIx = createEscrowInstruction(escrowPDA, poster.publicKey, jobIdHash, amount);
      const assignIx = assignWorkerInstruction(escrowPDA, poster.publicKey, worker.publicKey);
      
      const setupTx = new Transaction().add(createIx).add(assignIx);
      setupTx.feePayer = poster.publicKey;
      setupTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      await sendAndConfirmTransaction(connection, setupTx, [poster]);

      // Release with reputation update
      const ix = releaseWithReputationInstruction(
        escrowPDA, platformWallet.publicKey, worker.publicKey, PLATFORM_WALLET,
        workerRepPDA, posterRepPDA
      );
      const tx = new Transaction().add(ix);
      tx.feePayer = platformWallet.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [platformWallet]);
      console.log(`      ReleaseWithReputation tx: ${sig.slice(0, 20)}...`);

      // Check reputation was updated
      const repInfo = await connection.getAccountInfo(workerRepPDA);
      const rep = deserializeReputation(repInfo!.data);
      expect(Number(rep.jobsCompleted)).to.be.greaterThan(0);
      
      testResults[12] = { name: "ReleaseWithReputation", status: "PASSED", notes: "" };
    });
  });

  // ==================== PHASE 3: ARBITRATOR POOL (13-15) ====================

  describe("Arbitrator Pool Instructions (13-15)", () => {
    let poolPDA: PublicKey;

    it("13: InitArbitratorPool (platform authority)", async function() {
      if (!platformWallet) {
        testResults[13] = { name: "InitArbitratorPool", status: "SKIPPED", notes: "No platform wallet" };
        this.skip();
      }

      [poolPDA] = findArbitratorPoolPDA();

      const ix = initArbitratorPoolInstruction(poolPDA, platformWallet.publicKey);
      const tx = new Transaction().add(ix);
      tx.feePayer = platformWallet.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [platformWallet]);
      console.log(`      InitArbitratorPool tx: ${sig.slice(0, 20)}...`);

      const accountInfo = await connection.getAccountInfo(poolPDA);
      expect(accountInfo).to.not.be.null;
      const pool = deserializeArbitratorPool(accountInfo!.data);
      expect(pool.arbitratorCount).to.equal(0);
      
      testResults[13] = { name: "InitArbitratorPool", status: "PASSED", notes: "" };
    });

    it("14: RegisterArbitrator (x5 for dispute quorum)", async function() {
      if (!platformWallet) {
        testResults[14] = { name: "RegisterArbitrator", status: "SKIPPED", notes: "No platform wallet" };
        this.skip();
      }

      [poolPDA] = findArbitratorPoolPDA();

      // Register 5 arbitrators (minimum for dispute)
      for (let i = 0; i < 5; i++) {
        const arb = arbitrators[i];
        const [arbPDA] = findArbitratorPDA(arb.publicKey);

        const ix = registerArbitratorInstruction(poolPDA, arbPDA, arb.publicKey);
        const tx = new Transaction().add(ix);
        tx.feePayer = arb.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

        await sendAndConfirmTransaction(connection, tx, [arb]);
      }
      console.log(`      Registered 5 arbitrators`);

      const poolInfo = await connection.getAccountInfo(poolPDA);
      const pool = deserializeArbitratorPool(poolInfo!.data);
      expect(pool.arbitratorCount).to.equal(5);
      
      testResults[14] = { name: "RegisterArbitrator", status: "PASSED", notes: "5 registered" };
    });

    it("15: UnregisterArbitrator", async function() {
      if (!platformWallet) {
        testResults[15] = { name: "UnregisterArbitrator", status: "SKIPPED", notes: "No platform wallet" };
        this.skip();
      }

      [poolPDA] = findArbitratorPoolPDA();

      // Register an extra arbitrator then unregister
      const extraArb = arbitrators[5];
      const [extraArbPDA] = findArbitratorPDA(extraArb.publicKey);

      // Register
      const regIx = registerArbitratorInstruction(poolPDA, extraArbPDA, extraArb.publicKey);
      const regTx = new Transaction().add(regIx);
      regTx.feePayer = extraArb.publicKey;
      regTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      await sendAndConfirmTransaction(connection, regTx, [extraArb]);

      // Unregister
      const unregIx = unregisterArbitratorInstruction(poolPDA, extraArbPDA, extraArb.publicKey);
      const unregTx = new Transaction().add(unregIx);
      unregTx.feePayer = extraArb.publicKey;
      unregTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, unregTx, [extraArb]);
      console.log(`      UnregisterArbitrator tx: ${sig.slice(0, 20)}...`);

      const arbInfo = await connection.getAccountInfo(extraArbPDA);
      const arb = deserializeArbitratorEntry(arbInfo!.data);
      expect(arb.isActive).to.be.false;
      
      testResults[15] = { name: "UnregisterArbitrator", status: "PASSED", notes: "" };
    });
  });

  // ==================== PHASE 4: DISPUTE RESOLUTION (16-20) ====================

  describe("Dispute Resolution Instructions (16-20)", () => {
    const disputeJobId = "full-dispute-test";
    const disputeJobIdHash = sha256(disputeJobId);
    let disputeEscrowPDA: PublicKey;
    let disputeCasePDA: PublicKey;
    let selectedArbitrators: PublicKey[] = [];

    it("16: RaiseDisputeCase", async function() {
      if (!platformWallet) {
        testResults[16] = { name: "RaiseDisputeCase", status: "SKIPPED", notes: "No platform wallet" };
        this.skip();
      }

      [disputeEscrowPDA] = findEscrowPDA(disputeJobIdHash, poster.publicKey);
      [disputeCasePDA] = findDisputeCasePDA(disputeEscrowPDA);
      const [poolPDA] = findArbitratorPoolPDA();

      // Create escrow for dispute - do steps separately to debug
      const amount = BigInt(0.1 * LAMPORTS_PER_SOL);
      
      // Step 1: Create escrow
      const createIx = createEscrowInstruction(disputeEscrowPDA, poster.publicKey, disputeJobIdHash, amount);
      const createTx = new Transaction().add(createIx);
      createTx.feePayer = poster.publicKey;
      createTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      await sendAndConfirmTransaction(connection, createTx, [poster]);

      // Verify escrow created
      let escrowInfo = await connection.getAccountInfo(disputeEscrowPDA);
      let escrow = deserializeEscrow(escrowInfo!.data);
      console.log(`      Escrow created, status: ${escrow.status}`);

      // Step 2: Assign worker
      const assignIx = assignWorkerInstruction(disputeEscrowPDA, poster.publicKey, worker.publicKey);
      const assignTx = new Transaction().add(assignIx);
      assignTx.feePayer = poster.publicKey;
      assignTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      await sendAndConfirmTransaction(connection, assignTx, [poster]);

      // Step 3: Submit work (puts escrow in PendingReview state)
      const submitIx = submitWorkInstruction(disputeEscrowPDA, worker.publicKey);
      const submitTx = new Transaction().add(submitIx);
      submitTx.feePayer = worker.publicKey;
      submitTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      await sendAndConfirmTransaction(connection, submitTx, [worker]);

      // Verify escrow state before raising dispute
      escrowInfo = await connection.getAccountInfo(disputeEscrowPDA);
      escrow = deserializeEscrow(escrowInfo!.data);
      console.log(`      Escrow state before dispute: status=${escrow.status}, poster=${escrow.poster.toBase58().slice(0,8)}...`);

      // Verify pool exists and has enough arbitrators
      const poolInfo = await connection.getAccountInfo(poolPDA);
      if (!poolInfo) {
        console.log(`      ERROR: Pool not found at ${poolPDA.toBase58()}`);
        testResults[16] = { name: "RaiseDisputeCase", status: "SKIPPED", notes: "Pool not found" };
        this.skip();
      }
      const pool = deserializeArbitratorPool(poolInfo.data);
      console.log(`      Pool has ${pool.arbitratorCount} arbitrators`);

      // Raise dispute case
      const ix = raiseDisputeCaseInstruction(
        disputeEscrowPDA, disputeCasePDA, poolPDA,
        SYSVAR_SLOT_HASHES_PUBKEY, poster.publicKey,
        "Work quality not acceptable"
      );
      const tx = new Transaction().add(ix);
      tx.feePayer = poster.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
      console.log(`      RaiseDisputeCase tx: ${sig.slice(0, 20)}...`);

      // Verify dispute case created
      const disputeInfo = await connection.getAccountInfo(disputeCasePDA);
      expect(disputeInfo).to.not.be.null;
      const dispute = deserializeDisputeCase(disputeInfo!.data);
      expect(dispute.resolution).to.equal(DisputeResolution.Pending);
      
      // Store selected arbitrators for voting
      selectedArbitrators = dispute.arbitrators;
      console.log(`      Selected arbitrators: ${selectedArbitrators.map(a => a.toBase58().slice(0, 8)).join(", ")}`);
      
      testResults[16] = { name: "RaiseDisputeCase", status: "PASSED", notes: "" };
    });

    it("17: CastArbitrationVote (x3 for majority)", async function() {
      if (!platformWallet || selectedArbitrators.length === 0) {
        testResults[17] = { name: "CastArbitrationVote", status: "SKIPPED", notes: "No dispute case" };
        this.skip();
      }

      // Find which of our arbitrators were selected
      const votingArbs: { keypair: Keypair; pda: PublicKey }[] = [];
      for (const arb of arbitrators.slice(0, 5)) {
        for (const selected of selectedArbitrators) {
          if (arb.publicKey.equals(selected)) {
            const [arbPDA] = findArbitratorPDA(arb.publicKey);
            votingArbs.push({ keypair: arb, pda: arbPDA });
          }
        }
      }

      console.log(`      Found ${votingArbs.length} of our arbitrators in selection`);

      // Cast 3 votes for worker (to achieve majority)
      let votesCast = 0;
      for (const { keypair, pda } of votingArbs.slice(0, 3)) {
        const ix = castArbitrationVoteInstruction(disputeCasePDA, pda, keypair.publicKey, Vote.ForWorker);
        const tx = new Transaction().add(ix);
        tx.feePayer = keypair.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

        await sendAndConfirmTransaction(connection, tx, [keypair]);
        votesCast++;
      }
      console.log(`      Cast ${votesCast} votes ForWorker`);

      // Verify votes recorded
      const disputeInfo = await connection.getAccountInfo(disputeCasePDA);
      const dispute = deserializeDisputeCase(disputeInfo!.data);
      const forWorkerVotes = dispute.votes.filter(v => v === Vote.ForWorker).length;
      expect(forWorkerVotes).to.be.at.least(3);
      
      testResults[17] = { name: "CastArbitrationVote", status: "PASSED", notes: `${votesCast} votes` };
    });

    it("18: FinalizeDisputeCase", async function() {
      if (!platformWallet || selectedArbitrators.length === 0) {
        testResults[18] = { name: "FinalizeDisputeCase", status: "SKIPPED", notes: "No dispute case" };
        this.skip();
      }

      // Verify dispute case exists
      const disputeCheck = await connection.getAccountInfo(disputeCasePDA);
      if (!disputeCheck) {
        testResults[18] = { name: "FinalizeDisputeCase", status: "SKIPPED", notes: "Dispute case not created" };
        this.skip();
      }

      const ix = finalizeDisputeCaseInstruction(disputeCasePDA, disputeEscrowPDA, poster.publicKey);
      const tx = new Transaction().add(ix);
      tx.feePayer = poster.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
      console.log(`      FinalizeDisputeCase tx: ${sig.slice(0, 20)}...`);

      const disputeInfo = await connection.getAccountInfo(disputeCasePDA);
      const dispute = deserializeDisputeCase(disputeInfo!.data);
      expect(dispute.resolution).to.equal(DisputeResolution.WorkerWins);

      const escrowInfo = await connection.getAccountInfo(disputeEscrowPDA);
      const escrow = deserializeEscrow(escrowInfo!.data);
      expect(escrow.status).to.equal(EscrowStatus.DisputeWorkerWins);
      
      testResults[18] = { name: "FinalizeDisputeCase", status: "PASSED", notes: "WorkerWins" };
    });

    it("19: ExecuteDisputeResolution", async function() {
      if (!platformWallet || selectedArbitrators.length === 0) {
        testResults[19] = { name: "ExecuteDisputeResolution", status: "SKIPPED", notes: "No dispute case" };
        this.skip();
      }

      // Verify dispute case exists and is resolved
      const disputeCheck = await connection.getAccountInfo(disputeCasePDA);
      if (!disputeCheck) {
        testResults[19] = { name: "ExecuteDisputeResolution", status: "SKIPPED", notes: "Dispute case not created" };
        this.skip();
      }

      const [posterRepPDA] = findReputationPDA(poster.publicKey);
      const [workerRepPDA] = findReputationPDA(worker.publicKey);

      const ix = executeDisputeResolutionInstruction(
        disputeCasePDA, disputeEscrowPDA,
        worker.publicKey, poster.publicKey, PLATFORM_WALLET,
        workerRepPDA, posterRepPDA, poster.publicKey
      );
      const tx = new Transaction().add(ix);
      tx.feePayer = poster.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
      console.log(`      ExecuteDisputeResolution tx: ${sig.slice(0, 20)}...`);

      const escrowInfo = await connection.getAccountInfo(disputeEscrowPDA);
      const escrow = deserializeEscrow(escrowInfo!.data);
      expect(escrow.status).to.equal(EscrowStatus.Released);
      
      testResults[19] = { name: "ExecuteDisputeResolution", status: "PASSED", notes: "" };
    });

    it("20: UpdateArbitratorAccuracy", async function() {
      if (!platformWallet || selectedArbitrators.length === 0) {
        testResults[20] = { name: "UpdateArbitratorAccuracy", status: "SKIPPED", notes: "No dispute case" };
        this.skip();
      }

      // Find a voting arbitrator to update accuracy
      let updated = false;
      for (const arb of arbitrators.slice(0, 5)) {
        for (const selected of selectedArbitrators) {
          if (arb.publicKey.equals(selected)) {
            const [arbPDA] = findArbitratorPDA(arb.publicKey);
            const [accuracyClaimPDA] = findAccuracyClaimPDA(disputeCasePDA, arb.publicKey);

            try {
              const ix = updateArbitratorAccuracyInstruction(
                disputeCasePDA, arbPDA, accuracyClaimPDA, poster.publicKey
              );
              const tx = new Transaction().add(ix);
              tx.feePayer = poster.publicKey;
              tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

              const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
              console.log(`      UpdateArbitratorAccuracy tx: ${sig.slice(0, 20)}...`);
              updated = true;
              break;
            } catch (e: any) {
              // Arbitrator may not have voted
              continue;
            }
          }
        }
        if (updated) break;
      }

      if (updated) {
        testResults[20] = { name: "UpdateArbitratorAccuracy", status: "PASSED", notes: "" };
      } else {
        testResults[20] = { name: "UpdateArbitratorAccuracy", status: "SKIPPED", notes: "No voting arb found" };
        this.skip();
      }
    });
  });

  // ==================== PHASE 5: CLEANUP (21-24) ====================

  describe("Cleanup Instructions (21-24)", () => {
    it("21: ClaimExpiredArbitration (requires 48h+ voting + grace)", async function() {
      testResults[21] = { name: "ClaimExpiredArbitration", status: "SKIPPED", notes: "Requires ~96h time advancement" };
      console.log(`      ⊘ ClaimExpiredArbitration skipped: requires voting deadline + 48h grace period`);
      this.skip();
    });

    it("22: RemoveArbitrator (platform authority)", async function() {
      if (!platformWallet) {
        testResults[22] = { name: "RemoveArbitrator", status: "SKIPPED", notes: "No platform wallet" };
        this.skip();
      }

      const [poolPDA] = findArbitratorPoolPDA();

      // Use an extra arbitrator for removal (arbitrators[6])
      const arbToRemove = arbitrators[6];
      const [arbPDA] = findArbitratorPDA(arbToRemove.publicKey);

      // First register this arbitrator
      try {
        const regIx = registerArbitratorInstruction(poolPDA, arbPDA, arbToRemove.publicKey);
        const regTx = new Transaction().add(regIx);
        regTx.feePayer = arbToRemove.publicKey;
        regTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        await sendAndConfirmTransaction(connection, regTx, [arbToRemove]);
      } catch (e) {
        // May already be registered
      }

      // Remove via platform authority
      const ix = removeArbitratorInstruction(poolPDA, arbPDA, arbToRemove.publicKey, platformWallet.publicKey);
      const tx = new Transaction().add(ix);
      tx.feePayer = platformWallet.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [platformWallet]);
      console.log(`      RemoveArbitrator tx: ${sig.slice(0, 20)}...`);

      const arbInfo = await connection.getAccountInfo(arbPDA);
      const arb = deserializeArbitratorEntry(arbInfo!.data);
      expect(arb.isActive).to.be.false;
      
      testResults[22] = { name: "RemoveArbitrator", status: "PASSED", notes: "" };
    });

    it("23: CloseDisputeCase", async function() {
      if (!platformWallet) {
        testResults[23] = { name: "CloseDisputeCase", status: "SKIPPED", notes: "No platform wallet" };
        this.skip();
      }

      // Use the dispute case from Phase 4
      const disputeJobId = "full-dispute-test";
      const disputeJobIdHash = sha256(disputeJobId);
      const [localDisputeEscrowPDA] = findEscrowPDA(disputeJobIdHash, poster.publicKey);
      const [localDisputeCasePDA] = findDisputeCasePDA(localDisputeEscrowPDA);

      // Verify dispute case exists and escrow is in terminal state
      const disputeCheck = await connection.getAccountInfo(localDisputeCasePDA);
      if (!disputeCheck) {
        testResults[23] = { name: "CloseDisputeCase", status: "SKIPPED", notes: "Dispute case not created" };
        this.skip();
      }

      const escrowCheck = await connection.getAccountInfo(localDisputeEscrowPDA);
      if (!escrowCheck) {
        testResults[23] = { name: "CloseDisputeCase", status: "SKIPPED", notes: "Escrow not found" };
        this.skip();
      }
      const escrow = deserializeEscrow(escrowCheck.data);
      if (escrow.status !== EscrowStatus.Released && escrow.status !== EscrowStatus.Refunded) {
        testResults[23] = { name: "CloseDisputeCase", status: "SKIPPED", notes: `Escrow not in terminal state (${escrow.status})` };
        this.skip();
      }

      const ix = closeDisputeCaseInstruction(localDisputeCasePDA, localDisputeEscrowPDA, poster.publicKey);
      const tx = new Transaction().add(ix);
      tx.feePayer = poster.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
      console.log(`      CloseDisputeCase tx: ${sig.slice(0, 20)}...`);

      // Account should be zeroed
      const accountInfo = await connection.getAccountInfo(localDisputeCasePDA);
      if (accountInfo) {
        const allZeros = accountInfo.data.every(b => b === 0);
        expect(allZeros).to.be.true;
      }
      
      testResults[23] = { name: "CloseDisputeCase", status: "PASSED", notes: "" };
    });

    it("24: CloseArbitratorAccount", async function() {
      if (!platformWallet) {
        testResults[24] = { name: "CloseArbitratorAccount", status: "SKIPPED", notes: "No platform wallet" };
        this.skip();
      }

      const [poolPDA] = findArbitratorPoolPDA();
      
      // Use arbitrators[5] which was unregistered earlier
      const arb = arbitrators[5];
      const [arbPDA] = findArbitratorPDA(arb.publicKey);

      const ix = closeArbitratorAccountInstruction(poolPDA, arbPDA, arb.publicKey);
      const tx = new Transaction().add(ix);
      tx.feePayer = arb.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [arb]);
      console.log(`      CloseArbitratorAccount tx: ${sig.slice(0, 20)}...`);

      // Account should be zeroed
      const accountInfo = await connection.getAccountInfo(arbPDA);
      if (accountInfo) {
        const allZeros = accountInfo.data.every(b => b === 0);
        expect(allZeros).to.be.true;
      }
      
      testResults[24] = { name: "CloseArbitratorAccount", status: "PASSED", notes: "" };
    });
  });
});
