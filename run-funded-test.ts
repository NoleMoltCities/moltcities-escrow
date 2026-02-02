import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";

const PROGRAM_ID = new PublicKey("27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr");
const PLATFORM_WALLET = new PublicKey("BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893");

function sha256(data: string): Buffer {
  return createHash("sha256").update(data).digest();
}

function findEscrowPDA(jobIdHash: Buffer, poster: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), jobIdHash, poster.toBuffer()],
    PROGRAM_ID
  );
}

async function main() {
  const connection = new Connection("https://devnet.helius-rpc.com/?api-key=b7875804-ae02-4a11-845e-902e06a896c0", "confirmed");
  
  const poster = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("test-poster.json", "utf-8"))));
  const worker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("test-worker.json", "utf-8"))));
  
  console.log("Poster:", poster.publicKey.toBase58(), "Balance:", (await connection.getBalance(poster.publicKey)) / LAMPORTS_PER_SOL, "SOL");
  console.log("Worker:", worker.publicKey.toBase58(), "Balance:", (await connection.getBalance(worker.publicKey)) / LAMPORTS_PER_SOL, "SOL");
  
  const jobId = "pinocchio-test-" + Date.now();
  const jobIdHash = sha256(jobId);
  const [escrowPDA, bump] = findEscrowPDA(jobIdHash, poster.publicKey);
  const amount = BigInt(0.05 * LAMPORTS_PER_SOL);
  
  console.log("\n--- TEST 1: Create Escrow ---");
  console.log("Job ID:", jobId);
  console.log("Escrow PDA:", escrowPDA.toBase58());
  
  // CreateEscrowData: job_id_hash (32) + amount (8) + expiry_seconds (8) = 48 bytes
  // Plus discriminator (1) = 49 bytes total
  const createData = Buffer.alloc(1 + 32 + 8 + 8);
  createData.writeUInt8(0, 0); // discriminator for CreateEscrow
  jobIdHash.copy(createData, 1);
  createData.writeBigUInt64LE(amount, 33);
  createData.writeBigInt64LE(BigInt(0), 41); // 0 = use default expiry
  
  const createIx = new TransactionInstruction({
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: poster.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: createData,
  });
  
  try {
    const tx1 = new Transaction().add(createIx);
    const sig1 = await sendAndConfirmTransaction(connection, tx1, [poster]);
    console.log("✅ CreateEscrow SUCCESS:", sig1);
    
    const escrowAccount = await connection.getAccountInfo(escrowPDA);
    console.log("   Escrow account size:", escrowAccount?.data.length, "bytes");
  } catch (e: any) {
    console.log("❌ CreateEscrow FAILED:", e.message);
    if (e.logs) console.log("   Logs:", e.logs.slice(-5));
    return;
  }
  
  console.log("\n--- TEST 2: Assign Worker ---");
  
  // AssignWorkerData: worker_pubkey (32) = 32 bytes after discriminator
  const assignData = Buffer.alloc(1 + 32);
  assignData.writeUInt8(1, 0); // discriminator for AssignWorker
  worker.publicKey.toBuffer().copy(assignData, 1);
  
  const assignIx = new TransactionInstruction({
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: poster.publicKey, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: assignData,
  });
  
  try {
    const tx2 = new Transaction().add(assignIx);
    const sig2 = await sendAndConfirmTransaction(connection, tx2, [poster]);
    console.log("✅ AssignWorker SUCCESS:", sig2);
  } catch (e: any) {
    console.log("❌ AssignWorker FAILED:", e.message);
    if (e.logs) console.log("   Logs:", e.logs.slice(-5));
    return;
  }
  
  console.log("\n--- TEST 3: Submit Work ---");
  
  // SubmitWorkData: has_proof_hash (1) + proof_hash (32 if has) - let's send without proof
  const submitData = Buffer.alloc(1 + 1);
  submitData.writeUInt8(2, 0); // discriminator for SubmitWork
  submitData.writeUInt8(0, 1); // no proof hash
  
  const submitIx = new TransactionInstruction({
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: worker.publicKey, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: submitData,
  });
  
  try {
    const tx3 = new Transaction().add(submitIx);
    const sig3 = await sendAndConfirmTransaction(connection, tx3, [worker]);
    console.log("✅ SubmitWork SUCCESS:", sig3);
  } catch (e: any) {
    console.log("❌ SubmitWork FAILED:", e.message);
    if (e.logs) console.log("   Logs:", e.logs.slice(-5));
    return;
  }
  
  console.log("\n--- TEST 4: Approve Work ---");
  
  // ApproveWork: just discriminator
  const approveData = Buffer.alloc(1);
  approveData.writeUInt8(4, 0); // discriminator for ApproveWork
  
  const approveIx = new TransactionInstruction({
    keys: [
      { pubkey: escrowPDA, isSigner: false, isWritable: true },
      { pubkey: poster.publicKey, isSigner: true, isWritable: true },
      { pubkey: worker.publicKey, isSigner: false, isWritable: true },
      { pubkey: PLATFORM_WALLET, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data: approveData,
  });
  
  try {
    const tx4 = new Transaction().add(approveIx);
    const sig4 = await sendAndConfirmTransaction(connection, tx4, [poster]);
    console.log("✅ ApproveWork SUCCESS:", sig4);
    
    const workerBalance = await connection.getBalance(worker.publicKey);
    console.log("   Worker balance now:", workerBalance / LAMPORTS_PER_SOL, "SOL");
  } catch (e: any) {
    console.log("❌ ApproveWork FAILED:", e.message);
    if (e.logs) console.log("   Logs:", e.logs.slice(-5));
  }
  
  console.log("\n=== BASIC FLOW TEST COMPLETE ===");
}

main().catch(console.error);
