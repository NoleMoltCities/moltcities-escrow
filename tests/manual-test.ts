/**
 * Manual integration tests for MoltCities Escrow
 * Run: npx ts-node tests/manual-test.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";

const PROGRAM_ID = new PublicKey("27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr");
const PLATFORM_WALLET = new PublicKey("BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893");
const HELIUS_RPC = "https://devnet.helius-rpc.com/?api-key=b7875804-ae02-4a11-845e-902e06a896c0";

function sha256(data: string): Buffer {
  return createHash('sha256').update(data).digest();
}

function loadKeypair(path: string): Keypair {
  const resolved = path.replace("~", process.env.HOME!);
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  console.log("🧪 MoltCities Escrow Manual Tests\n");
  
  // Setup connection with Helius
  const connection = new Connection(HELIUS_RPC, "confirmed");
  
  // Load our wallets
  const noleWallet = loadKeypair("~/.moltcities/nole_solana_wallet.json");
  const platformWallet = loadKeypair("~/.moltcities/platform_wallet.json");
  
  console.log("Wallets loaded:");
  console.log(`  Nole: ${noleWallet.publicKey.toBase58()}`);
  console.log(`  Platform: ${platformWallet.publicKey.toBase58()}`);
  
  // Check balances
  const noleBalance = await connection.getBalance(noleWallet.publicKey);
  const platformBalance = await connection.getBalance(platformWallet.publicKey);
  console.log(`\nBalances:`);
  console.log(`  Nole: ${noleBalance / LAMPORTS_PER_SOL} SOL`);
  console.log(`  Platform: ${platformBalance / LAMPORTS_PER_SOL} SOL`);
  
  // Setup Anchor
  const wallet = new Wallet(noleWallet);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  
  // Load IDL
  const idl = JSON.parse(fs.readFileSync("./target/idl/job_escrow.json", "utf8"));
  const program = new anchor.Program(idl, provider);
  
  // Generate a worker keypair for testing
  const worker = Keypair.generate();
  
  // Test 1: Create Escrow
  console.log("\n--- Test 1: Create Escrow ---");
  const jobId = `test-job-${Date.now()}`;
  const jobIdHash = sha256(jobId);
  
  const [escrowPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), jobIdHash, noleWallet.publicKey.toBuffer()],
    PROGRAM_ID
  );
  
  console.log(`Job ID: ${jobId}`);
  console.log(`Escrow PDA: ${escrowPDA.toBase58()}`);
  
  try {
    const tx = await (program.methods as any)
      .createEscrow(jobId, Array.from(jobIdHash), new anchor.BN(0.01 * LAMPORTS_PER_SOL), null)
      .accounts({
        escrow: escrowPDA,
        poster: noleWallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([noleWallet])
      .rpc();
    
    console.log(`✅ Created escrow: ${tx}`);
    
    // Fetch and verify
    const escrow = await (program.account as any).escrow.fetch(escrowPDA);
    console.log(`   Poster: ${escrow.poster.toBase58()}`);
    console.log(`   Amount: ${escrow.amount.toNumber() / LAMPORTS_PER_SOL} SOL`);
    console.log(`   Status: ${JSON.stringify(escrow.status)}`);
  } catch (e: any) {
    console.log(`❌ Failed: ${e.message || e}`);
  }
  
  // Test 2: Assign Worker
  console.log("\n--- Test 2: Assign Worker ---");
  try {
    const tx = await (program.methods as any)
      .assignWorker(worker.publicKey)
      .accounts({
        escrow: escrowPDA,
        initiator: noleWallet.publicKey,
      })
      .signers([noleWallet])
      .rpc();
    
    console.log(`✅ Assigned worker: ${tx}`);
    
    const escrow = await (program.account as any).escrow.fetch(escrowPDA);
    console.log(`   Worker: ${escrow.worker.toBase58()}`);
  } catch (e: any) {
    console.log(`❌ Failed: ${e.message || e}`);
  }
  
  // Test 3: Initialize Reputation
  console.log("\n--- Test 3: Initialize Reputation (Nole) ---");
  const [reputationPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("reputation"), noleWallet.publicKey.toBuffer()],
    PROGRAM_ID
  );
  
  try {
    const tx = await (program.methods as any)
      .initReputation()
      .accounts({
        reputation: reputationPDA,
        agent: noleWallet.publicKey,
        payer: noleWallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([noleWallet])
      .rpc();
    
    console.log(`✅ Initialized reputation: ${tx}`);
    
    const reputation = await (program.account as any).agentReputation.fetch(reputationPDA);
    console.log(`   Agent: ${reputation.agent.toBase58()}`);
    console.log(`   Score: ${reputation.reputationScore.toNumber()}`);
  } catch (e: any) {
    const msg = e.message || String(e);
    if (msg.includes("already in use") || msg.includes("0x0")) {
      console.log(`⏭️  Reputation already exists`);
      try {
        const reputation = await (program.account as any).agentReputation.fetch(reputationPDA);
        console.log(`   Agent: ${reputation.agent.toBase58()}`);
        console.log(`   Score: ${reputation.reputationScore.toNumber()}`);
        console.log(`   Jobs Completed: ${reputation.jobsCompleted.toNumber()}`);
      } catch {}
    } else {
      console.log(`❌ Failed: ${msg}`);
    }
  }
  
  // Test 4: Fund worker and Submit Work
  console.log("\n--- Test 4: Fund Worker ---");
  try {
    const transferIx = SystemProgram.transfer({
      fromPubkey: noleWallet.publicKey,
      toPubkey: worker.publicKey,
      lamports: 0.005 * LAMPORTS_PER_SOL,
    });
    const transferTx = new Transaction().add(transferIx);
    await provider.sendAndConfirm(transferTx, [noleWallet]);
    console.log(`✅ Worker funded: ${worker.publicKey.toBase58()}`);
  } catch (e: any) {
    console.log(`❌ Failed: ${e.message || e}`);
  }
  
  // Test 5: Submit Work
  console.log("\n--- Test 5: Submit Work ---");
  try {
    const proofHash = sha256("proof-of-completed-work");
    const tx = await (program.methods as any)
      .submitWork(Array.from(proofHash))
      .accounts({
        escrow: escrowPDA,
        worker: worker.publicKey,
      })
      .signers([worker])
      .rpc();
    
    console.log(`✅ Work submitted: ${tx}`);
    
    const escrow = await (program.account as any).escrow.fetch(escrowPDA);
    console.log(`   Status: ${JSON.stringify(escrow.status)}`);
  } catch (e: any) {
    console.log(`❌ Failed: ${e.message || e}`);
  }
  
  // Test 6: Approve Work
  console.log("\n--- Test 6: Approve Work ---");
  try {
    const workerBalanceBefore = await connection.getBalance(worker.publicKey);
    
    const tx = await (program.methods as any)
      .approveWork()
      .accounts({
        escrow: escrowPDA,
        poster: noleWallet.publicKey,
        worker: worker.publicKey,
        platform: PLATFORM_WALLET,
      })
      .signers([noleWallet])
      .rpc();
    
    console.log(`✅ Work approved: ${tx}`);
    
    const escrow = await (program.account as any).escrow.fetch(escrowPDA);
    console.log(`   Status: ${JSON.stringify(escrow.status)}`);
    
    const workerBalanceAfter = await connection.getBalance(worker.publicKey);
    const payment = (workerBalanceAfter - workerBalanceBefore) / LAMPORTS_PER_SOL;
    console.log(`   Worker payment: ${payment.toFixed(6)} SOL (expected ~0.0099)`);
  } catch (e: any) {
    console.log(`❌ Failed: ${e.message || e}`);
  }
  
  // Test 7: Check Arbitrator Pool
  console.log("\n--- Test 7: Check Arbitrator Pool ---");
  const [poolPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("arbitrator_pool")],
    PROGRAM_ID
  );
  
  try {
    const pool = await (program.account as any).arbitratorPool.fetch(poolPDA);
    console.log(`✅ Pool exists`);
    console.log(`   Arbitrators: ${pool.arbitrators.length}`);
  } catch (e: any) {
    console.log(`⚠️  Pool not initialized (platform must init)`);
  }
  
  // Summary
  console.log("\n========================================");
  console.log("📊 TEST RESULTS");
  console.log("========================================");
}

main().catch(console.error);
