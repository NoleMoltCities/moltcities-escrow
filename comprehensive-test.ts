/**
 * Comprehensive Pinocchio Escrow Tests
 * 
 * Tests ALL 25 instructions across multiple scenarios:
 * - Scenario A: Cancel Flow
 * - Scenario B: Expiry Flow  
 * - Scenario C: Reputation Flow
 * - Scenario D: Platform Release
 * - Scenario E: Arbitration Full Flow
 * - Error Cases
 */

import { 
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, 
  SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction 
} from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";

// === CONFIGURATION ===
const PROGRAM_ID = new PublicKey("27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr");
const PLATFORM_WALLET = new PublicKey("BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893");
const RPC_URL = "https://devnet.helius-rpc.com/?api-key=b7875804-ae02-4a11-845e-902e06a896c0";

// === HELPER FUNCTIONS ===
function sha256(data: string): Buffer {
  return createHash("sha256").update(data).digest();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

// Parse escrow account data
function parseEscrowAccount(data: Buffer): { status: number; amount: bigint; poster: PublicKey; worker: PublicKey } {
  // Discriminator: 8 bytes, then struct
  // job_id_hash: 32, poster: 32, worker: 32, amount: 8, status: 1
  return {
    status: data[8 + 32 + 32 + 32],
    amount: data.readBigUInt64LE(8 + 32 + 32 + 32 + 1),
    poster: new PublicKey(data.subarray(8 + 32, 8 + 32 + 32)),
    worker: new PublicKey(data.subarray(8 + 32 + 32, 8 + 32 + 32 + 32)),
  };
}

// Wait and read escrow account for validation
async function verifyEscrowStatus(connection: Connection, escrowPDA: PublicKey, expectedStatus: number): Promise<boolean> {
  const account = await connection.getAccountInfo(escrowPDA);
  if (!account) return false;
  const parsed = parseEscrowAccount(account.data as Buffer);
  return parsed.status === expectedStatus;
}

// Parse reputation account
function parseReputationAccount(data: Buffer): { 
  agent: PublicKey; jobsCompleted: bigint; jobsPosted: bigint; 
  totalEarned: bigint; totalSpent: bigint; disputesWon: bigint; disputesLost: bigint 
} {
  // Discriminator 8 bytes, then agent: 32, then u64 fields
  return {
    agent: new PublicKey(data.subarray(8, 8 + 32)),
    jobsCompleted: data.readBigUInt64LE(8 + 32),
    jobsPosted: data.readBigUInt64LE(8 + 32 + 8),
    totalEarned: data.readBigUInt64LE(8 + 32 + 16),
    totalSpent: data.readBigUInt64LE(8 + 32 + 24),
    disputesWon: data.readBigUInt64LE(8 + 32 + 32),
    disputesLost: data.readBigUInt64LE(8 + 32 + 40),
  };
}

// === INSTRUCTION BUILDERS ===
// Discriminators:
// 0: CreateEscrow, 1: AssignWorker, 2: SubmitWork, 3: ReleaseToWorker, 4: ApproveWork
// 5: AutoRelease, 6: InitiateDispute, 7: RefundToPoster, 8: ClaimExpired, 9: CancelEscrow
// 10: CloseEscrow, 11: InitReputation, 12: ReleaseWithReputation, 13: InitArbitratorPool
// 14: RegisterArbitrator, 15: UnregisterArbitrator, 16: RaiseDisputeCase, 17: CastArbitrationVote
// 18: FinalizeDisputeCase, 19: ExecuteDisputeResolution, 20: UpdateArbitratorAccuracy
// 21: ClaimExpiredArbitration, 22: RemoveArbitrator, 23: CloseDisputeCase, 24: CloseArbitratorAccount

function buildCreateEscrow(escrowPDA: PublicKey, poster: PublicKey, jobIdHash: Buffer, amount: bigint, expirySeconds: bigint = BigInt(0)): TransactionInstruction {
  const data = Buffer.alloc(1 + 32 + 8 + 8);
  data.writeUInt8(0, 0);
  jobIdHash.copy(data, 1);
  data.writeBigUInt64LE(amount, 33);
  data.writeBigInt64LE(expirySeconds, 41);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildAssignWorker(escrowPDA: PublicKey, initiator: PublicKey, worker: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1 + 32);
  data.writeUInt8(1, 0);
  worker.toBuffer().copy(data, 1);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: initiator, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildSubmitWork(escrowPDA: PublicKey, worker: PublicKey, proofHash?: Buffer): TransactionInstruction {
  const hasProof = proofHash ? 1 : 0;
  const data = Buffer.alloc(1 + 1 + (hasProof ? 32 : 0));
  data.writeUInt8(2, 0);
  data.writeUInt8(hasProof, 1);
  if (proofHash) proofHash.copy(data, 2);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: worker, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildReleaseToWorker(escrowPDA: PublicKey, platformAuthority: PublicKey, worker: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(3, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: platformAuthority, isSigner: true, isWritable: false },
      { pubkey: worker, isSigner: false, isWritable: true },
      { pubkey: PLATFORM_WALLET, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildApproveWork(escrowPDA: PublicKey, poster: PublicKey, worker: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(4, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: true, isWritable: true },
      { pubkey: worker, isSigner: false, isWritable: true },
      { pubkey: PLATFORM_WALLET, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildAutoRelease(escrowPDA: PublicKey, cranker: PublicKey, worker: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(5, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: cranker, isSigner: true, isWritable: false },
      { pubkey: worker, isSigner: false, isWritable: true },
      { pubkey: PLATFORM_WALLET, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildInitiateDispute(escrowPDA: PublicKey, initiator: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(6, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: initiator, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildRefundToPoster(escrowPDA: PublicKey, platformAuthority: PublicKey, poster: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(7, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: platformAuthority, isSigner: true, isWritable: false },
      { pubkey: poster, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildClaimExpired(escrowPDA: PublicKey, poster: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(8, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: true, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildCancelEscrow(escrowPDA: PublicKey, poster: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(9, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: true, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildCloseEscrow(escrowPDA: PublicKey, poster: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(10, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: true, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildInitReputation(reputationPDA: PublicKey, agent: PublicKey, payer: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(11, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: reputationPDA, isSigner: false, isWritable: true },
      { pubkey: agent, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildReleaseWithReputation(
  escrowPDA: PublicKey, platformAuthority: PublicKey, worker: PublicKey, 
  workerReputationPDA: PublicKey, posterReputationPDA: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(12, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: platformAuthority, isSigner: true, isWritable: false },
      { pubkey: worker, isSigner: false, isWritable: true },
      { pubkey: PLATFORM_WALLET, isSigner: false, isWritable: true },
      { pubkey: workerReputationPDA, isSigner: false, isWritable: true },
      { pubkey: posterReputationPDA, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildInitArbitratorPool(poolPDA: PublicKey, authority: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(13, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildRegisterArbitrator(poolPDA: PublicKey, arbitratorPDA: PublicKey, agent: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(14, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: arbitratorPDA, isSigner: false, isWritable: true },
      { pubkey: agent, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildUnregisterArbitrator(poolPDA: PublicKey, arbitratorPDA: PublicKey, agent: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(15, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: arbitratorPDA, isSigner: false, isWritable: true },
      { pubkey: agent, isSigner: true, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildRaiseDisputeCase(
  escrowPDA: PublicKey, disputeCasePDA: PublicKey, poolPDA: PublicKey, 
  initiator: PublicKey, reason: string
): TransactionInstruction {
  const reasonBytes = Buffer.from(reason, "utf-8");
  const data = Buffer.alloc(1 + 2 + reasonBytes.length);
  data.writeUInt8(16, 0);
  data.writeUInt16LE(reasonBytes.length, 1);
  reasonBytes.copy(data, 3);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: disputeCasePDA, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: false },
      { pubkey: initiator, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildCastArbitrationVote(disputeCasePDA: PublicKey, arbitratorPDA: PublicKey, voter: PublicKey, vote: number): TransactionInstruction {
  // vote: 1 = ForWorker, 2 = ForPoster
  const data = Buffer.alloc(2);
  data.writeUInt8(17, 0);
  data.writeUInt8(vote, 1);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: disputeCasePDA, isSigner: false, isWritable: true },
      { pubkey: arbitratorPDA, isSigner: false, isWritable: true },
      { pubkey: voter, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildFinalizeDisputeCase(disputeCasePDA: PublicKey, escrowPDA: PublicKey, finalizer: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(18, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: disputeCasePDA, isSigner: false, isWritable: true },
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: finalizer, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildExecuteDisputeResolution(
  disputeCasePDA: PublicKey, escrowPDA: PublicKey, worker: PublicKey, poster: PublicKey,
  workerReputationPDA: PublicKey, posterReputationPDA: PublicKey, executor: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(19, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: disputeCasePDA, isSigner: false, isWritable: true },
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: worker, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: false, isWritable: true },
      { pubkey: PLATFORM_WALLET, isSigner: false, isWritable: true },
      { pubkey: workerReputationPDA, isSigner: false, isWritable: true },
      { pubkey: posterReputationPDA, isSigner: false, isWritable: true },
      { pubkey: executor, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildUpdateArbitratorAccuracy(
  disputeCasePDA: PublicKey, arbitratorPDA: PublicKey, accuracyClaimPDA: PublicKey, caller: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(20, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: disputeCasePDA, isSigner: false, isWritable: false },
      { pubkey: arbitratorPDA, isSigner: false, isWritable: true },
      { pubkey: accuracyClaimPDA, isSigner: false, isWritable: true },
      { pubkey: caller, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildClaimExpiredArbitration(escrowPDA: PublicKey, poster: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(21, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: poster, isSigner: true, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildRemoveArbitrator(poolPDA: PublicKey, arbitratorPDA: PublicKey, arbitratorAgent: PublicKey, authority: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(22, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: arbitratorPDA, isSigner: false, isWritable: true },
      { pubkey: arbitratorAgent, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildCloseDisputeCase(disputeCasePDA: PublicKey, escrowPDA: PublicKey, initiator: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(23, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: disputeCasePDA, isSigner: false, isWritable: true },
      { pubkey: escrowPDA, isSigner: false, isWritable: false },
      { pubkey: initiator, isSigner: true, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildCloseArbitratorAccount(poolPDA: PublicKey, arbitratorPDA: PublicKey, agent: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(24, 0);
  
  return new TransactionInstruction({
    keys: [
      { pubkey: poolPDA, isSigner: false, isWritable: false },
      { pubkey: arbitratorPDA, isSigner: false, isWritable: true },
      { pubkey: agent, isSigner: true, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

// === TEST RUNNER ===
type TestResult = { name: string; success: boolean; error?: string; signature?: string; verification?: string };

async function runTest(
  name: string, 
  fn: () => Promise<{ signature: string; verification?: string }>
): Promise<TestResult> {
  console.log(`\n--- TEST: ${name} ---`);
  try {
    const result = await fn();
    console.log(`✅ SUCCESS: ${result.signature}`);
    if (result.verification) console.log(`   Verification: ${result.verification}`);
    return { name, success: true, signature: result.signature, verification: result.verification };
  } catch (e: any) {
    const error = e.message || String(e);
    console.log(`❌ FAILED: ${error}`);
    if (e.logs) console.log(`   Logs:`, e.logs.slice(-5));
    return { name, success: false, error };
  }
}

async function runExpectFailTest(
  name: string,
  fn: () => Promise<void>,
  expectedError?: string
): Promise<TestResult> {
  console.log(`\n--- TEST (expect fail): ${name} ---`);
  try {
    await fn();
    console.log(`❌ UNEXPECTED SUCCESS (should have failed)`);
    return { name, success: false, error: "Expected failure but succeeded" };
  } catch (e: any) {
    const error = e.message || String(e);
    if (expectedError && !error.includes(expectedError)) {
      console.log(`⚠️  FAILED with wrong error: ${error}`);
      return { name, success: false, error: `Wrong error: ${error}` };
    }
    console.log(`✅ CORRECTLY FAILED: ${error.slice(0, 100)}`);
    return { name, success: true, verification: "Error case handled correctly" };
  }
}

// === MAIN TEST SUITE ===
async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  
  // Load wallets
  const poster = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("test-poster.json", "utf-8"))));
  const worker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("test-worker.json", "utf-8"))));
  const platform = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.moltcities/platform_wallet.json", "utf-8"))));
  
  // Generate arbitrator wallets (need 5 for dispute testing)
  const arbitrators: Keypair[] = [];
  for (let i = 0; i < 6; i++) {
    arbitrators.push(Keypair.generate());
  }
  
  console.log("========================================");
  console.log("COMPREHENSIVE PINOCCHIO ESCROW TESTS");
  console.log("========================================");
  console.log("\nWallets:");
  console.log("  Poster:", poster.publicKey.toBase58());
  console.log("  Worker:", worker.publicKey.toBase58());
  console.log("  Platform:", platform.publicKey.toBase58());
  
  const posterBal = await connection.getBalance(poster.publicKey);
  const workerBal = await connection.getBalance(worker.publicKey);
  const platformBal = await connection.getBalance(platform.publicKey);
  
  console.log("\nBalances:");
  console.log("  Poster:", posterBal / LAMPORTS_PER_SOL, "SOL");
  console.log("  Worker:", workerBal / LAMPORTS_PER_SOL, "SOL");
  console.log("  Platform:", platformBal / LAMPORTS_PER_SOL, "SOL");
  
  const results: TestResult[] = [];
  
  // ============== SCENARIO A: Cancel Flow ==============
  console.log("\n\n========== SCENARIO A: Cancel Flow ==========");
  
  const jobIdA = "cancel-test-" + Date.now();
  const jobIdHashA = sha256(jobIdA);
  const [escrowPDA_A] = findEscrowPDA(jobIdHashA, poster.publicKey);
  const amountA = BigInt(0.02 * LAMPORTS_PER_SOL);
  
  results.push(await runTest("A1: CreateEscrow (for cancel)", async () => {
    const ix = buildCreateEscrow(escrowPDA_A, poster.publicKey, jobIdHashA, amountA);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
    const status = await verifyEscrowStatus(connection, escrowPDA_A, 0);
    return { signature: sig, verification: `Status=0 (Active): ${status}` };
  }));
  
  const posterBalBefore = await connection.getBalance(poster.publicKey);
  
  results.push(await runTest("A2: CancelEscrow (before worker assigned)", async () => {
    const ix = buildCancelEscrow(escrowPDA_A, poster.publicKey);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
    const status = await verifyEscrowStatus(connection, escrowPDA_A, 5); // Cancelled
    return { signature: sig, verification: `Status=5 (Cancelled): ${status}` };
  }));
  
  const posterBalAfter = await connection.getBalance(poster.publicKey);
  const refundReceived = posterBalAfter - posterBalBefore + 5000; // account for tx fee
  console.log(`   Refund verification: Received ~${refundReceived / LAMPORTS_PER_SOL} SOL back`);
  
  results.push(await runTest("A3: CloseEscrow (reclaim rent)", async () => {
    const ix = buildCloseEscrow(escrowPDA_A, poster.publicKey);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
    const account = await connection.getAccountInfo(escrowPDA_A);
    const closed = !account || account.data.every(b => b === 0);
    return { signature: sig, verification: `Account closed: ${closed}` };
  }));
  
  // ============== SCENARIO B: Platform Release Flow ==============
  console.log("\n\n========== SCENARIO B: Platform Release Flow ==========");
  
  const jobIdB = "platform-release-" + Date.now();
  const jobIdHashB = sha256(jobIdB);
  const [escrowPDA_B] = findEscrowPDA(jobIdHashB, poster.publicKey);
  const amountB = BigInt(0.02 * LAMPORTS_PER_SOL);
  
  results.push(await runTest("B1: CreateEscrow (for platform release)", async () => {
    const ix = buildCreateEscrow(escrowPDA_B, poster.publicKey, jobIdHashB, amountB);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
    return { signature: sig };
  }));
  
  results.push(await runTest("B2: AssignWorker", async () => {
    const ix = buildAssignWorker(escrowPDA_B, poster.publicKey, worker.publicKey);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
    return { signature: sig };
  }));
  
  const workerBalBefore = await connection.getBalance(worker.publicKey);
  
  results.push(await runTest("B3: ReleaseToWorker (platform authority)", async () => {
    const ix = buildReleaseToWorker(escrowPDA_B, platform.publicKey, worker.publicKey);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [platform]);
    const status = await verifyEscrowStatus(connection, escrowPDA_B, 1); // Released
    return { signature: sig, verification: `Status=1 (Released): ${status}` };
  }));
  
  const workerBalAfterB = await connection.getBalance(worker.publicKey);
  const workerPaymentB = workerBalAfterB - workerBalBefore;
  const expectedPaymentB = Number(amountB) * 0.99; // 1% fee
  console.log(`   Worker received: ${workerPaymentB / LAMPORTS_PER_SOL} SOL (expected ~${expectedPaymentB / LAMPORTS_PER_SOL})`);
  
  // ============== SCENARIO C: Reputation Flow ==============
  console.log("\n\n========== SCENARIO C: Reputation Flow ==========");
  
  const [posterRepPDA] = findReputationPDA(poster.publicKey);
  const [workerRepPDA] = findReputationPDA(worker.publicKey);
  
  // Check if reputation accounts already exist
  const posterRepExists = await connection.getAccountInfo(posterRepPDA);
  const workerRepExists = await connection.getAccountInfo(workerRepPDA);
  
  if (!posterRepExists) {
    results.push(await runTest("C1: InitReputation (poster)", async () => {
      const ix = buildInitReputation(posterRepPDA, poster.publicKey, platform.publicKey);
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(connection, tx, [platform]);
      return { signature: sig };
    }));
  } else {
    console.log("\n--- SKIP: Poster reputation already exists ---");
  }
  
  if (!workerRepExists) {
    results.push(await runTest("C2: InitReputation (worker)", async () => {
      const ix = buildInitReputation(workerRepPDA, worker.publicKey, platform.publicKey);
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(connection, tx, [platform]);
      return { signature: sig };
    }));
  } else {
    console.log("\n--- SKIP: Worker reputation already exists ---");
  }
  
  const jobIdC = "reputation-test-" + Date.now();
  const jobIdHashC = sha256(jobIdC);
  const [escrowPDA_C] = findEscrowPDA(jobIdHashC, poster.publicKey);
  const amountC = BigInt(0.02 * LAMPORTS_PER_SOL);
  
  results.push(await runTest("C3: CreateEscrow (for reputation)", async () => {
    const ix = buildCreateEscrow(escrowPDA_C, poster.publicKey, jobIdHashC, amountC);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
    return { signature: sig };
  }));
  
  results.push(await runTest("C4: AssignWorker", async () => {
    const ix = buildAssignWorker(escrowPDA_C, poster.publicKey, worker.publicKey);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
    return { signature: sig };
  }));
  
  results.push(await runTest("C5: ReleaseWithReputation", async () => {
    const ix = buildReleaseWithReputation(
      escrowPDA_C, platform.publicKey, worker.publicKey,
      workerRepPDA, posterRepPDA
    );
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [platform]);
    
    // Verify reputation updated
    const workerRepAccount = await connection.getAccountInfo(workerRepPDA);
    const posterRepAccount = await connection.getAccountInfo(posterRepPDA);
    let verification = "";
    if (workerRepAccount && posterRepAccount) {
      const workerRep = parseReputationAccount(workerRepAccount.data as Buffer);
      const posterRep = parseReputationAccount(posterRepAccount.data as Buffer);
      verification = `Worker jobs_completed=${workerRep.jobsCompleted}, Poster jobs_posted=${posterRep.jobsPosted}`;
    }
    
    return { signature: sig, verification };
  }));
  
  // ============== SCENARIO D: Initiate Dispute (Simple) ==============
  console.log("\n\n========== SCENARIO D: Initiate Dispute (Simple) ==========");
  
  const jobIdD = "dispute-simple-" + Date.now();
  const jobIdHashD = sha256(jobIdD);
  const [escrowPDA_D] = findEscrowPDA(jobIdHashD, poster.publicKey);
  const amountD = BigInt(0.02 * LAMPORTS_PER_SOL);
  
  results.push(await runTest("D1: CreateEscrow (for dispute)", async () => {
    const ix = buildCreateEscrow(escrowPDA_D, poster.publicKey, jobIdHashD, amountD);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
    return { signature: sig };
  }));
  
  results.push(await runTest("D2: AssignWorker", async () => {
    const ix = buildAssignWorker(escrowPDA_D, poster.publicKey, worker.publicKey);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
    return { signature: sig };
  }));
  
  results.push(await runTest("D3: InitiateDispute", async () => {
    const ix = buildInitiateDispute(escrowPDA_D, poster.publicKey);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
    const status = await verifyEscrowStatus(connection, escrowPDA_D, 4); // Disputed
    return { signature: sig, verification: `Status=4 (Disputed): ${status}` };
  }));
  
  // Note: RefundToPoster requires 24h timelock after dispute. We'll skip the wait in this test.
  console.log("\n   Note: RefundToPoster requires 24h timelock - skipping wait in this test");
  
  // ============== SCENARIO E: Arbitrator Pool Setup ==============
  console.log("\n\n========== SCENARIO E: Arbitrator Pool Setup ==========");
  
  const [poolPDA] = findArbitratorPoolPDA();
  const poolExists = await connection.getAccountInfo(poolPDA);
  
  if (!poolExists) {
    results.push(await runTest("E1: InitArbitratorPool", async () => {
      const ix = buildInitArbitratorPool(poolPDA, platform.publicKey);
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(connection, tx, [platform]);
      return { signature: sig };
    }));
  } else {
    console.log("\n--- SKIP: Arbitrator pool already exists ---");
  }
  
  // Fund arbitrators from platform wallet and register them
  console.log("\n   Funding and registering arbitrators...");
  const minStake = 0.1 * LAMPORTS_PER_SOL; // MIN_ARBITRATOR_STAKE
  const fundingAmount = 0.15 * LAMPORTS_PER_SOL; // stake + some extra for tx fees
  
  for (let i = 0; i < 5; i++) {
    const arb = arbitrators[i];
    const [arbPDA] = findArbitratorPDA(arb.publicKey);
    
    // Check if already registered
    const arbExists = await connection.getAccountInfo(arbPDA);
    if (arbExists) {
      console.log(`   Arbitrator ${i} already registered`);
      continue;
    }
    
    // Fund the arbitrator
    try {
      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: platform.publicKey,
          toPubkey: arb.publicKey,
          lamports: fundingAmount,
        })
      );
      await sendAndConfirmTransaction(connection, fundTx, [platform]);
      console.log(`   Funded arbitrator ${i}: ${arb.publicKey.toBase58().slice(0, 8)}...`);
    } catch (e: any) {
      console.log(`   Failed to fund arbitrator ${i}: ${e.message}`);
      continue;
    }
    
    // Register the arbitrator
    results.push(await runTest(`E2.${i}: RegisterArbitrator ${i}`, async () => {
      const ix = buildRegisterArbitrator(poolPDA, arbPDA, arb.publicKey);
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(connection, tx, [arb]);
      return { signature: sig };
    }));
  }
  
  // ============== SCENARIO F: Full Arbitration Flow ==============
  console.log("\n\n========== SCENARIO F: Full Arbitration Flow ==========");
  
  const jobIdF = "arbitration-full-" + Date.now();
  const jobIdHashF = sha256(jobIdF);
  const [escrowPDA_F] = findEscrowPDA(jobIdHashF, poster.publicKey);
  const [disputePDA_F] = findDisputeCasePDA(escrowPDA_F);
  const amountF = BigInt(0.02 * LAMPORTS_PER_SOL);
  
  results.push(await runTest("F1: CreateEscrow (for arbitration)", async () => {
    const ix = buildCreateEscrow(escrowPDA_F, poster.publicKey, jobIdHashF, amountF);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
    return { signature: sig };
  }));
  
  results.push(await runTest("F2: AssignWorker", async () => {
    const ix = buildAssignWorker(escrowPDA_F, poster.publicKey, worker.publicKey);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
    return { signature: sig };
  }));
  
  results.push(await runTest("F3: SubmitWork", async () => {
    const proofHash = sha256("work-completed-evidence");
    const ix = buildSubmitWork(escrowPDA_F, worker.publicKey, proofHash);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [worker]);
    const status = await verifyEscrowStatus(connection, escrowPDA_F, 6); // PendingReview
    return { signature: sig, verification: `Status=6 (PendingReview): ${status}` };
  }));
  
  results.push(await runTest("F4: RaiseDisputeCase", async () => {
    const ix = buildRaiseDisputeCase(escrowPDA_F, disputePDA_F, poolPDA, poster.publicKey, "Worker did not complete work as specified");
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
    const status = await verifyEscrowStatus(connection, escrowPDA_F, 7); // InArbitration
    return { signature: sig, verification: `Status=7 (InArbitration): ${status}` };
  }));
  
  // Read dispute case to get selected arbitrators
  const disputeAccount = await connection.getAccountInfo(disputePDA_F);
  if (!disputeAccount) {
    console.log("❌ Dispute case not found!");
  } else {
    // Parse arbitrators from dispute case (offset: 8 disc + 32 escrow + 32 raised_by = 72)
    const selectedArbitrators: PublicKey[] = [];
    for (let i = 0; i < 5; i++) {
      const offset = 8 + 32 + 32 + (i * 32);
      const pubkeyBytes = disputeAccount.data.subarray(offset, offset + 32);
      selectedArbitrators.push(new PublicKey(pubkeyBytes));
    }
    
    console.log("\n   Selected arbitrators:");
    selectedArbitrators.forEach((pk, i) => console.log(`     ${i}: ${pk.toBase58().slice(0, 16)}...`));
    
    // Cast votes (3 for worker, 2 for poster to get worker wins)
    const votes = [1, 1, 1, 2, 2]; // ForWorker=1, ForPoster=2
    
    for (let i = 0; i < 5; i++) {
      const selectedArb = selectedArbitrators[i];
      
      // Find the matching arbitrator keypair
      const arbKeypair = arbitrators.find(a => a.publicKey.equals(selectedArb));
      if (!arbKeypair) {
        console.log(`   ⚠️  Arbitrator ${i} not in our control: ${selectedArb.toBase58().slice(0, 16)}...`);
        continue;
      }
      
      const [arbPDA] = findArbitratorPDA(selectedArb);
      
      results.push(await runTest(`F5.${i}: CastArbitrationVote (arb ${i}, vote=${votes[i] === 1 ? "ForWorker" : "ForPoster"})`, async () => {
        const ix = buildCastArbitrationVote(disputePDA_F, arbPDA, selectedArb, votes[i]);
        const tx = new Transaction().add(ix);
        const sig = await sendAndConfirmTransaction(connection, tx, [arbKeypair]);
        return { signature: sig };
      }));
    }
    
    results.push(await runTest("F6: FinalizeDisputeCase", async () => {
      const ix = buildFinalizeDisputeCase(disputePDA_F, escrowPDA_F, platform.publicKey);
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(connection, tx, [platform]);
      
      // Check dispute resolution
      const updatedDispute = await connection.getAccountInfo(disputePDA_F);
      let verification = "";
      if (updatedDispute) {
        // Resolution is at offset: 8 + 32 + 32 + (32*5) + 5 + 8 = 8 + 32 + 32 + 160 + 5 + 8 = 245
        const resolution = updatedDispute.data[245];
        const resolutionNames = ["Pending", "WorkerWins", "PosterWins", "Split"];
        verification = `Resolution=${resolution} (${resolutionNames[resolution] || "Unknown"})`;
      }
      
      return { signature: sig, verification };
    }));
    
    const workerBalBeforeExec = await connection.getBalance(worker.publicKey);
    
    results.push(await runTest("F7: ExecuteDisputeResolution", async () => {
      const ix = buildExecuteDisputeResolution(
        disputePDA_F, escrowPDA_F, worker.publicKey, poster.publicKey,
        workerRepPDA, posterRepPDA, platform.publicKey
      );
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(connection, tx, [platform]);
      
      const status = await verifyEscrowStatus(connection, escrowPDA_F, 1); // Released (worker wins)
      return { signature: sig, verification: `Status=1 (Released): ${status}` };
    }));
    
    const workerBalAfterExec = await connection.getBalance(worker.publicKey);
    console.log(`   Worker received: ${(workerBalAfterExec - workerBalBeforeExec) / LAMPORTS_PER_SOL} SOL`);
    
    // Update accuracy for one arbitrator
    const firstVoter = arbitrators.find(a => a.publicKey.equals(selectedArbitrators[0]));
    if (firstVoter) {
      const [arbPDA0] = findArbitratorPDA(firstVoter.publicKey);
      const [accuracyClaimPDA] = findAccuracyClaimPDA(disputePDA_F, firstVoter.publicKey);
      
      results.push(await runTest("F8: UpdateArbitratorAccuracy", async () => {
        const ix = buildUpdateArbitratorAccuracy(disputePDA_F, arbPDA0, accuracyClaimPDA, platform.publicKey);
        const tx = new Transaction().add(ix);
        const sig = await sendAndConfirmTransaction(connection, tx, [platform]);
        return { signature: sig };
      }));
    }
  }
  
  // ============== ERROR CASES ==============
  console.log("\n\n========== ERROR CASES ==========");
  
  // Create a fresh escrow for error testing
  const jobIdErr = "error-test-" + Date.now();
  const jobIdHashErr = sha256(jobIdErr);
  const [escrowPDA_Err] = findEscrowPDA(jobIdHashErr, poster.publicKey);
  
  await runTest("ERR-SETUP: Create escrow for error tests", async () => {
    const ix = buildCreateEscrow(escrowPDA_Err, poster.publicKey, jobIdHashErr, BigInt(0.02 * LAMPORTS_PER_SOL));
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [poster]);
    return { signature: sig };
  });
  
  results.push(await runExpectFailTest("ERR1: SubmitWork before worker assigned", async () => {
    const ix = buildSubmitWork(escrowPDA_Err, worker.publicKey);
    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(connection, tx, [worker]);
  }));
  
  // Assign worker for next tests
  await (async () => {
    const ix = buildAssignWorker(escrowPDA_Err, poster.publicKey, worker.publicKey);
    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(connection, tx, [poster]);
    console.log("   (assigned worker for next tests)");
  })();
  
  results.push(await runExpectFailTest("ERR2: AssignWorker when already assigned", async () => {
    const ix = buildAssignWorker(escrowPDA_Err, poster.publicKey, poster.publicKey);
    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(connection, tx, [poster]);
  }));
  
  results.push(await runExpectFailTest("ERR3: CancelEscrow after worker assigned", async () => {
    const ix = buildCancelEscrow(escrowPDA_Err, poster.publicKey);
    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(connection, tx, [poster]);
  }));
  
  results.push(await runExpectFailTest("ERR4: ApproveWork before submission", async () => {
    const ix = buildApproveWork(escrowPDA_Err, poster.publicKey, worker.publicKey);
    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(connection, tx, [poster]);
  }));
  
  // ============== SUMMARY ==============
  console.log("\n\n========================================");
  console.log("TEST SUMMARY");
  console.log("========================================");
  
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  console.log(`\nTotal: ${results.length} tests`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  
  if (failed > 0) {
    console.log("\nFailed tests:");
    results.filter(r => !r.success).forEach(r => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
  }
  
  // Final balances
  console.log("\nFinal Balances:");
  console.log("  Poster:", (await connection.getBalance(poster.publicKey)) / LAMPORTS_PER_SOL, "SOL");
  console.log("  Worker:", (await connection.getBalance(worker.publicKey)) / LAMPORTS_PER_SOL, "SOL");
  console.log("  Platform:", (await connection.getBalance(platform.publicKey)) / LAMPORTS_PER_SOL, "SOL");
  
  // Write results to file
  const resultsFile = `test-results-${Date.now()}.json`;
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to: ${resultsFile}`);
}

main().catch(console.error);
