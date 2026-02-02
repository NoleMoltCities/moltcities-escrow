/**
 * MoltCities Job Escrow - Unit Tests
 * 
 * Tests for instruction builders and state deserializers
 * These tests don't require a running validator
 */

import {
  PublicKey,
  Keypair,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { expect } from "chai";

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

// ==================== UNIT TESTS ====================

describe("Unit Tests - Pinocchio Escrow", () => {
  describe("PDA Derivation", () => {
    it("derives escrow PDA correctly", () => {
      const poster = Keypair.generate().publicKey;
      const jobIdHash = sha256("test-job-123");
      const [pda, bump] = findEscrowPDA(jobIdHash, poster);
      
      expect(pda).to.be.instanceOf(PublicKey);
      expect(bump).to.be.a("number");
      expect(bump).to.be.lessThanOrEqual(255);
      
      // Verify determinism
      const [pda2, bump2] = findEscrowPDA(jobIdHash, poster);
      expect(pda.equals(pda2)).to.be.true;
      expect(bump).to.equal(bump2);
    });

    it("derives reputation PDA correctly", () => {
      const agent = Keypair.generate().publicKey;
      const [pda, bump] = findReputationPDA(agent);
      
      expect(pda).to.be.instanceOf(PublicKey);
      expect(bump).to.be.a("number");
    });

    it("derives arbitrator pool PDA correctly", () => {
      const [pda, bump] = findArbitratorPoolPDA();
      
      expect(pda).to.be.instanceOf(PublicKey);
      expect(bump).to.be.a("number");
      
      // Should be deterministic singleton
      const [pda2, bump2] = findArbitratorPoolPDA();
      expect(pda.equals(pda2)).to.be.true;
    });

    it("different job IDs produce different PDAs", () => {
      const poster = Keypair.generate().publicKey;
      const [pda1] = findEscrowPDA(sha256("job-1"), poster);
      const [pda2] = findEscrowPDA(sha256("job-2"), poster);
      
      expect(pda1.equals(pda2)).to.be.false;
    });
  });

  describe("Instruction Builders", () => {
    const poster = Keypair.generate();
    const worker = Keypair.generate();
    const jobIdHash = sha256("test-job");
    const [escrowPDA] = findEscrowPDA(jobIdHash, poster.publicKey);

    it("builds CreateEscrow instruction correctly", () => {
      const amount = BigInt(0.1 * LAMPORTS_PER_SOL);
      const ix = createEscrowInstruction(escrowPDA, poster.publicKey, jobIdHash, amount);

      // Check program ID
      expect(ix.programId.equals(PROGRAM_ID)).to.be.true;

      // Check accounts
      expect(ix.keys.length).to.equal(3);
      expect(ix.keys[0].pubkey.equals(escrowPDA)).to.be.true;
      expect(ix.keys[0].isWritable).to.be.true;
      expect(ix.keys[1].pubkey.equals(poster.publicKey)).to.be.true;
      expect(ix.keys[1].isSigner).to.be.true;
      expect(ix.keys[2].pubkey.equals(SystemProgram.programId)).to.be.true;

      // Check data format
      expect(ix.data.length).to.equal(1 + 32 + 8 + 8);
      expect(ix.data[0]).to.equal(DISCRIMINATORS.CreateEscrow);
      
      // Check job_id_hash is embedded
      expect(ix.data.subarray(1, 33).equals(jobIdHash)).to.be.true;
      
      // Check amount is little-endian
      const embeddedAmount = ix.data.readBigUInt64LE(33);
      expect(embeddedAmount).to.equal(amount);
    });

    it("builds AssignWorker instruction correctly", () => {
      const ix = assignWorkerInstruction(escrowPDA, poster.publicKey, worker.publicKey);

      expect(ix.programId.equals(PROGRAM_ID)).to.be.true;
      expect(ix.keys.length).to.equal(2);
      expect(ix.data[0]).to.equal(DISCRIMINATORS.AssignWorker);
      expect(ix.data.length).to.equal(1 + 32);
      
      // Worker pubkey should be in data
      const embeddedWorker = new PublicKey(ix.data.subarray(1, 33));
      expect(embeddedWorker.equals(worker.publicKey)).to.be.true;
    });

    it("builds SubmitWork instruction with proof hash", () => {
      const proofHash = sha256("proof-data");
      const ix = submitWorkInstruction(escrowPDA, worker.publicKey, proofHash);

      expect(ix.programId.equals(PROGRAM_ID)).to.be.true;
      expect(ix.keys.length).to.equal(2);
      expect(ix.data[0]).to.equal(DISCRIMINATORS.SubmitWork);
      expect(ix.data[1]).to.equal(1); // has_proof = true
      expect(ix.data.length).to.equal(1 + 1 + 32);
      expect(ix.data.subarray(2, 34).equals(proofHash)).to.be.true;
    });

    it("builds SubmitWork instruction without proof hash", () => {
      const ix = submitWorkInstruction(escrowPDA, worker.publicKey);

      expect(ix.data[0]).to.equal(DISCRIMINATORS.SubmitWork);
      expect(ix.data[1]).to.equal(0); // has_proof = false
      expect(ix.data.length).to.equal(2);
    });

    it("builds ApproveWork instruction correctly", () => {
      const ix = approveWorkInstruction(escrowPDA, poster.publicKey, worker.publicKey, PLATFORM_WALLET);

      expect(ix.programId.equals(PROGRAM_ID)).to.be.true;
      expect(ix.keys.length).to.equal(4);
      expect(ix.data[0]).to.equal(DISCRIMINATORS.ApproveWork);
      expect(ix.data.length).to.equal(1);
      
      // Check account order
      expect(ix.keys[0].pubkey.equals(escrowPDA)).to.be.true;
      expect(ix.keys[1].pubkey.equals(poster.publicKey)).to.be.true;
      expect(ix.keys[1].isSigner).to.be.true;
      expect(ix.keys[2].pubkey.equals(worker.publicKey)).to.be.true;
      expect(ix.keys[3].pubkey.equals(PLATFORM_WALLET)).to.be.true;
    });

    it("builds CancelEscrow instruction correctly", () => {
      const ix = cancelEscrowInstruction(escrowPDA, poster.publicKey);

      expect(ix.programId.equals(PROGRAM_ID)).to.be.true;
      expect(ix.keys.length).to.equal(2);
      expect(ix.data[0]).to.equal(DISCRIMINATORS.CancelEscrow);
      expect(ix.data.length).to.equal(1);
    });

    it("builds InitReputation instruction correctly", () => {
      const [reputationPDA] = findReputationPDA(poster.publicKey);
      const ix = initReputationInstruction(reputationPDA, poster.publicKey, poster.publicKey);

      expect(ix.programId.equals(PROGRAM_ID)).to.be.true;
      expect(ix.keys.length).to.equal(4);
      expect(ix.data[0]).to.equal(DISCRIMINATORS.InitReputation);
      expect(ix.data.length).to.equal(1);
    });
  });

  describe("SHA256 Hashing", () => {
    it("produces consistent hashes", () => {
      const data = "test-job-123";
      const hash1 = sha256(data);
      const hash2 = sha256(data);
      
      expect(hash1.equals(hash2)).to.be.true;
      expect(hash1.length).to.equal(32);
    });

    it("produces different hashes for different inputs", () => {
      const hash1 = sha256("job-1");
      const hash2 = sha256("job-2");
      
      expect(hash1.equals(hash2)).to.be.false;
    });
  });

  describe("Discriminator Values", () => {
    it("has correct discriminator for all instructions", () => {
      // Verify discriminators match lib.rs ordering
      expect(DISCRIMINATORS.CreateEscrow).to.equal(0);
      expect(DISCRIMINATORS.AssignWorker).to.equal(1);
      expect(DISCRIMINATORS.SubmitWork).to.equal(2);
      expect(DISCRIMINATORS.ReleaseToWorker).to.equal(3);
      expect(DISCRIMINATORS.ApproveWork).to.equal(4);
      expect(DISCRIMINATORS.AutoRelease).to.equal(5);
      expect(DISCRIMINATORS.InitiateDispute).to.equal(6);
      expect(DISCRIMINATORS.RefundToPoster).to.equal(7);
      expect(DISCRIMINATORS.ClaimExpired).to.equal(8);
      expect(DISCRIMINATORS.CancelEscrow).to.equal(9);
      expect(DISCRIMINATORS.CloseEscrow).to.equal(10);
      expect(DISCRIMINATORS.InitReputation).to.equal(11);
      expect(DISCRIMINATORS.ReleaseWithReputation).to.equal(12);
      expect(DISCRIMINATORS.InitArbitratorPool).to.equal(13);
      expect(DISCRIMINATORS.RegisterArbitrator).to.equal(14);
      expect(DISCRIMINATORS.UnregisterArbitrator).to.equal(15);
      expect(DISCRIMINATORS.RaiseDisputeCase).to.equal(16);
      expect(DISCRIMINATORS.CastArbitrationVote).to.equal(17);
      expect(DISCRIMINATORS.FinalizeDisputeCase).to.equal(18);
      expect(DISCRIMINATORS.ExecuteDisputeResolution).to.equal(19);
      expect(DISCRIMINATORS.UpdateArbitratorAccuracy).to.equal(20);
      expect(DISCRIMINATORS.ClaimExpiredArbitration).to.equal(21);
      expect(DISCRIMINATORS.RemoveArbitrator).to.equal(22);
      expect(DISCRIMINATORS.CloseDisputeCase).to.equal(23);
      expect(DISCRIMINATORS.CloseArbitratorAccount).to.equal(24);
    });
  });

  describe("Data Serialization", () => {
    it("serializes CreateEscrow data in correct byte order", () => {
      const poster = Keypair.generate();
      const jobIdHash = sha256("test");
      const amount = BigInt(100_000_000); // 0.1 SOL
      const expiry = BigInt(2592000); // 30 days
      const [escrowPDA] = findEscrowPDA(jobIdHash, poster.publicKey);
      
      const ix = createEscrowInstruction(escrowPDA, poster.publicKey, jobIdHash, amount, expiry);
      
      // Parse back the data
      const data = ix.data;
      expect(data[0]).to.equal(0); // discriminator
      
      const parsedJobHash = data.subarray(1, 33);
      expect(parsedJobHash.equals(jobIdHash)).to.be.true;
      
      const parsedAmount = data.readBigUInt64LE(33);
      expect(parsedAmount).to.equal(amount);
      
      const parsedExpiry = data.readBigInt64LE(41);
      expect(parsedExpiry).to.equal(expiry);
    });
  });

  describe("Constants", () => {
    it("has correct program ID", () => {
      expect(PROGRAM_ID.toBase58()).to.equal("27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr");
    });

    it("has correct platform wallet", () => {
      expect(PLATFORM_WALLET.toBase58()).to.equal("BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893");
    });
  });
});

console.log("✓ Unit tests validate instruction builders and PDA derivation");
console.log("✓ These tests don't require a running validator");
console.log("✓ On-chain tests require deploying the new Pinocchio program first");
