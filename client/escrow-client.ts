/**
 * MoltCities Escrow Client Library
 * 
 * TypeScript client for the Pinocchio-based escrow program.
 * Provides typed helpers for all 25 instructions.
 * 
 * Program ID: 27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr
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
  Commitment,
} from '@solana/web3.js';
import { createHash } from 'crypto';

// ============================================================================
// Constants
// ============================================================================

export const PROGRAM_ID = new PublicKey('27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr');
export const PLATFORM_WALLET = new PublicKey('BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893');

// Instruction discriminators (single byte)
export enum Instruction {
  CreateEscrow = 0,
  AssignWorker = 1,
  SubmitWork = 2,
  ReleaseToWorker = 3,
  ApproveWork = 4,
  AutoRelease = 5,
  InitiateDispute = 6,
  RefundToPoster = 7,
  ClaimExpired = 8,
  CancelEscrow = 9,
  CloseEscrow = 10,
  InitReputation = 11,
  ReleaseWithReputation = 12,
  InitArbitratorPool = 13,
  RegisterArbitrator = 14,
  UnregisterArbitrator = 15,
  RaiseDisputeCase = 16,
  CastArbitrationVote = 17,
  FinalizeDisputeCase = 18,
  ExecuteDisputeResolution = 19,
  UpdateArbitratorAccuracy = 20,
  ClaimExpiredArbitration = 21,
  RemoveArbitrator = 22,
  CloseDisputeCase = 23,
  CloseArbitratorAccount = 24,
}

// Account sizes
export const ESCROW_SIZE = 224;
export const REPUTATION_SIZE = 72;
export const ARBITRATOR_POOL_SIZE = 40;
export const ARBITRATOR_ENTRY_SIZE = 96;
export const DISPUTE_CASE_SIZE = 296;
export const VOTE_SIZE = 40;

// ============================================================================
// Utility Functions
// ============================================================================

export function sha256(data: string): Buffer {
  return createHash('sha256').update(data).digest();
}

export function findEscrowPDA(jobIdHash: Buffer, poster: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), jobIdHash, poster.toBuffer()],
    PROGRAM_ID
  );
}

export function findReputationPDA(agent: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('reputation'), agent.toBuffer()],
    PROGRAM_ID
  );
}

export function findArbitratorPoolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('arbitrator_pool')],
    PROGRAM_ID
  );
}

export function findArbitratorPDA(agent: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('arbitrator'), agent.toBuffer()],
    PROGRAM_ID
  );
}

export function findDisputeCasePDA(escrow: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('dispute'), escrow.toBuffer()],
    PROGRAM_ID
  );
}

export function findVotePDA(dispute: PublicKey, arbitrator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vote'), dispute.toBuffer(), arbitrator.toBuffer()],
    PROGRAM_ID
  );
}

export function findAccuracyClaimPDA(dispute: PublicKey, arbitrator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('accuracy_claimed'), dispute.toBuffer(), arbitrator.toBuffer()],
    PROGRAM_ID
  );
}

// ============================================================================
// Instruction Builders
// ============================================================================

/**
 * Create a new escrow for a job
 * Data: job_id_hash (32) + amount (8) + expiry_seconds (8)
 */
export function createEscrowInstruction(
  escrow: PublicKey,
  poster: PublicKey,
  jobIdHash: Buffer,
  amount: bigint,
  expirySeconds: bigint = BigInt(0), // 0 = use default
): TransactionInstruction {
  const data = Buffer.alloc(1 + 32 + 8 + 8);
  data.writeUInt8(Instruction.CreateEscrow, 0);
  jobIdHash.copy(data, 1);
  data.writeBigUInt64LE(amount, 33);
  data.writeBigInt64LE(expirySeconds, 41);

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
 * Assign a worker to an escrow
 * Data: worker_pubkey (32)
 */
export function assignWorkerInstruction(
  escrow: PublicKey,
  poster: PublicKey,
  worker: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1 + 32);
  data.writeUInt8(Instruction.AssignWorker, 0);
  worker.toBuffer().copy(data, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Worker submits work
 * Data: has_proof (1) + proof_hash (32 if has_proof)
 */
export function submitWorkInstruction(
  escrow: PublicKey,
  worker: PublicKey,
  proofHash?: Buffer,
): TransactionInstruction {
  const hasProof = proofHash !== undefined;
  const data = Buffer.alloc(1 + 1 + (hasProof ? 32 : 0));
  data.writeUInt8(Instruction.SubmitWork, 0);
  data.writeUInt8(hasProof ? 1 : 0, 1);
  if (hasProof && proofHash) {
    proofHash.copy(data, 2);
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
 * Platform releases funds to worker
 * Data: none (just discriminator)
 */
export function releaseToWorkerInstruction(
  escrow: PublicKey,
  platformAuthority: PublicKey,
  worker: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.ReleaseToWorker, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: platformAuthority, isSigner: true, isWritable: true },
      { pubkey: worker, isSigner: false, isWritable: true },
      { pubkey: PLATFORM_WALLET, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Poster approves work and releases funds
 * Data: none (just discriminator)
 */
export function approveWorkInstruction(
  escrow: PublicKey,
  poster: PublicKey,
  worker: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.ApproveWork, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: true, isWritable: true },
      { pubkey: worker, isSigner: false, isWritable: true },
      { pubkey: PLATFORM_WALLET, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Auto-release after review window (cranker)
 * Data: none (just discriminator)
 */
export function autoReleaseInstruction(
  escrow: PublicKey,
  cranker: PublicKey,
  worker: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.AutoRelease, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: cranker, isSigner: true, isWritable: false },
      { pubkey: worker, isSigner: false, isWritable: true },
      { pubkey: PLATFORM_WALLET, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Poster initiates dispute
 * Data: none (just discriminator)
 */
export function initiateDisputeInstruction(
  escrow: PublicKey,
  poster: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.InitiateDispute, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Refund to poster after dispute timelock
 * Data: none (just discriminator)
 */
export function refundToPosterInstruction(
  escrow: PublicKey,
  poster: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.RefundToPoster, 0);

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
 * Poster claims expired escrow
 * Data: none (just discriminator)
 */
export function claimExpiredInstruction(
  escrow: PublicKey,
  poster: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.ClaimExpired, 0);

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
 * Cancel escrow before worker assigned
 * Data: none (just discriminator)
 */
export function cancelEscrowInstruction(
  escrow: PublicKey,
  poster: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.CancelEscrow, 0);

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
 * Close escrow and reclaim rent
 * Data: none (just discriminator)
 */
export function closeEscrowInstruction(
  escrow: PublicKey,
  poster: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.CloseEscrow, 0);

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
 * Initialize reputation PDA for an agent
 * Data: none (just discriminator)
 */
export function initReputationInstruction(
  reputation: PublicKey,
  agent: PublicKey,
  payer: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.InitReputation, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: reputation, isSigner: false, isWritable: true },
      { pubkey: agent, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Release with reputation updates
 * Data: none (just discriminator)
 */
export function releaseWithReputationInstruction(
  escrow: PublicKey,
  poster: PublicKey,
  worker: PublicKey,
  posterReputation: PublicKey,
  workerReputation: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.ReleaseWithReputation, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: true, isWritable: true },
      { pubkey: worker, isSigner: false, isWritable: true },
      { pubkey: PLATFORM_WALLET, isSigner: false, isWritable: true },
      { pubkey: posterReputation, isSigner: false, isWritable: true },
      { pubkey: workerReputation, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Initialize arbitrator pool (one-time)
 * Data: none (just discriminator)
 */
export function initArbitratorPoolInstruction(
  pool: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.InitArbitratorPool, 0);

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

/**
 * Register as arbitrator (stake required)
 * Data: stake_amount (8)
 */
export function registerArbitratorInstruction(
  pool: PublicKey,
  arbitratorEntry: PublicKey,
  agent: PublicKey,
  stakeAmount: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(1 + 8);
  data.writeUInt8(Instruction.RegisterArbitrator, 0);
  data.writeBigUInt64LE(stakeAmount, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: arbitratorEntry, isSigner: false, isWritable: true },
      { pubkey: agent, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Unregister as arbitrator (get stake back)
 * Data: none (just discriminator)
 */
export function unregisterArbitratorInstruction(
  pool: PublicKey,
  arbitratorEntry: PublicKey,
  agent: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.UnregisterArbitrator, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: arbitratorEntry, isSigner: false, isWritable: true },
      { pubkey: agent, isSigner: true, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Raise dispute case (selects 5 random arbitrators)
 * Data: none (just discriminator)
 */
export function raiseDisputeCaseInstruction(
  escrow: PublicKey,
  disputeCase: PublicKey,
  initiator: PublicKey,
  pool: PublicKey,
  // Plus arbitrator entries (up to 5)
  arbitratorEntries: PublicKey[],
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.RaiseDisputeCase, 0);

  const keys = [
    { pubkey: escrow, isSigner: false, isWritable: true },
    { pubkey: disputeCase, isSigner: false, isWritable: true },
    { pubkey: initiator, isSigner: true, isWritable: true },
    { pubkey: pool, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...arbitratorEntries.map(ae => ({ pubkey: ae, isSigner: false, isWritable: false })),
  ];

  return new TransactionInstruction({
    keys,
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Cast arbitration vote
 * Data: vote (1) - 0 = ForWorker, 1 = ForPoster
 */
export function castArbitrationVoteInstruction(
  disputeCase: PublicKey,
  vote: PublicKey,
  arbitrator: PublicKey,
  arbitratorEntry: PublicKey,
  voteValue: 0 | 1, // 0 = ForWorker, 1 = ForPoster
): TransactionInstruction {
  const data = Buffer.alloc(1 + 1);
  data.writeUInt8(Instruction.CastArbitrationVote, 0);
  data.writeUInt8(voteValue, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: disputeCase, isSigner: false, isWritable: true },
      { pubkey: vote, isSigner: false, isWritable: true },
      { pubkey: arbitrator, isSigner: true, isWritable: true },
      { pubkey: arbitratorEntry, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Finalize dispute case (determine winner)
 * Data: none (just discriminator)
 */
export function finalizeDisputeCaseInstruction(
  disputeCase: PublicKey,
  escrow: PublicKey,
  caller: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.FinalizeDisputeCase, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: disputeCase, isSigner: false, isWritable: true },
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: caller, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Execute dispute resolution (transfer funds)
 * Data: none (just discriminator)
 */
export function executeDisputeResolutionInstruction(
  disputeCase: PublicKey,
  escrow: PublicKey,
  poster: PublicKey,
  worker: PublicKey,
  caller: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.ExecuteDisputeResolution, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: disputeCase, isSigner: false, isWritable: true },
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: false, isWritable: true },
      { pubkey: worker, isSigner: false, isWritable: true },
      { pubkey: PLATFORM_WALLET, isSigner: false, isWritable: true },
      { pubkey: caller, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Update arbitrator accuracy after dispute
 * Data: none (just discriminator)
 */
export function updateArbitratorAccuracyInstruction(
  disputeCase: PublicKey,
  arbitratorEntry: PublicKey,
  vote: PublicKey,
  accuracyClaim: PublicKey,
  arbitrator: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.UpdateArbitratorAccuracy, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: disputeCase, isSigner: false, isWritable: false },
      { pubkey: arbitratorEntry, isSigner: false, isWritable: true },
      { pubkey: vote, isSigner: false, isWritable: false },
      { pubkey: accuracyClaim, isSigner: false, isWritable: true },
      { pubkey: arbitrator, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Claim expired arbitration (emergency recovery)
 * Data: none (just discriminator)
 */
export function claimExpiredArbitrationInstruction(
  disputeCase: PublicKey,
  escrow: PublicKey,
  poster: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.ClaimExpiredArbitration, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: disputeCase, isSigner: false, isWritable: true },
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: true, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Platform removes bad arbitrator
 * Data: none (just discriminator)
 */
export function removeArbitratorInstruction(
  pool: PublicKey,
  arbitratorEntry: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.RemoveArbitrator, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: arbitratorEntry, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Close resolved dispute case
 * Data: none (just discriminator)
 */
export function closeDisputeCaseInstruction(
  disputeCase: PublicKey,
  escrow: PublicKey,
  closer: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.CloseDisputeCase, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: disputeCase, isSigner: false, isWritable: true },
      { pubkey: escrow, isSigner: false, isWritable: false },
      { pubkey: closer, isSigner: true, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Close inactive arbitrator account
 * Data: none (just discriminator)
 */
export function closeArbitratorAccountInstruction(
  pool: PublicKey,
  arbitratorEntry: PublicKey,
  agent: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(Instruction.CloseArbitratorAccount, 0);

  return new TransactionInstruction({
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: arbitratorEntry, isSigner: false, isWritable: true },
      { pubkey: agent, isSigner: true, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

// ============================================================================
// High-Level Client Class
// ============================================================================

export class EscrowClient {
  connection: Connection;
  commitment: Commitment;

  constructor(rpcUrl: string, commitment: Commitment = 'confirmed') {
    this.connection = new Connection(rpcUrl, commitment);
    this.commitment = commitment;
  }

  async createEscrow(
    poster: Keypair,
    jobId: string,
    amountSol: number,
    expirySeconds?: number,
  ): Promise<{ signature: string; escrow: PublicKey; jobIdHash: Buffer }> {
    const jobIdHash = sha256(jobId);
    const [escrow] = findEscrowPDA(jobIdHash, poster.publicKey);
    const amount = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));

    const ix = createEscrowInstruction(
      escrow,
      poster.publicKey,
      jobIdHash,
      amount,
      BigInt(expirySeconds || 0),
    );

    const tx = new Transaction().add(ix);
    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [poster],
      { commitment: this.commitment },
    );

    return { signature, escrow, jobIdHash };
  }

  async assignWorker(
    poster: Keypair,
    escrow: PublicKey,
    worker: PublicKey,
  ): Promise<string> {
    const ix = assignWorkerInstruction(escrow, poster.publicKey, worker);
    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [poster], {
      commitment: this.commitment,
    });
  }

  async submitWork(
    worker: Keypair,
    escrow: PublicKey,
    proofHash?: Buffer,
  ): Promise<string> {
    const ix = submitWorkInstruction(escrow, worker.publicKey, proofHash);
    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [worker], {
      commitment: this.commitment,
    });
  }

  async approveWork(
    poster: Keypair,
    escrow: PublicKey,
    worker: PublicKey,
  ): Promise<string> {
    const ix = approveWorkInstruction(escrow, poster.publicKey, worker);
    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [poster], {
      commitment: this.commitment,
    });
  }

  async cancelEscrow(poster: Keypair, escrow: PublicKey): Promise<string> {
    const ix = cancelEscrowInstruction(escrow, poster.publicKey);
    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [poster], {
      commitment: this.commitment,
    });
  }

  async getEscrowBalance(escrow: PublicKey): Promise<number> {
    const balance = await this.connection.getBalance(escrow);
    return balance / LAMPORTS_PER_SOL;
  }
}

// ============================================================================
// Exports
// ============================================================================

export default EscrowClient;
