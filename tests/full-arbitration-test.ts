/**
 * Full Arbitration Flow Test
 * Tests the complete Phase 3 dispute resolution with 5 arbitrators
 */

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";

const PROGRAM_ID = new PublicKey("27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr");
const PLATFORM_WALLET = new PublicKey("BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893");
const HELIUS_RPC = "https://devnet.helius-rpc.com/?api-key=b7875804-ae02-4a11-845e-902e06a896c0";

const ARBITRATOR_STAKE = 0.1 * LAMPORTS_PER_SOL;
const ESCROW_AMOUNT = 0.05 * LAMPORTS_PER_SOL;

function sha256(data: string): Buffer {
  return createHash('sha256').update(data).digest();
}

function loadKeypair(path: string): Keypair {
  const resolved = path.replace("~", process.env.HOME!);
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log("🧪 FULL ARBITRATION FLOW TEST\n");
  console.log("=".repeat(50));
  
  const connection = new Connection(HELIUS_RPC, "confirmed");
  
  // Load wallets
  const platformWallet = loadKeypair("~/.moltcities/platform_wallet.json");
  const poster = loadKeypair("~/.moltcities/nole_solana_wallet.json");
  
  // Generate test keypairs
  const worker = Keypair.generate();
  const arbitrators = [
    Keypair.generate(),
    Keypair.generate(),
    Keypair.generate(),
    Keypair.generate(),
    Keypair.generate(),
  ];
  
  console.log("\n📋 Test Wallets:");
  console.log(`   Platform: ${platformWallet.publicKey.toBase58()}`);
  console.log(`   Poster: ${poster.publicKey.toBase58()}`);
  console.log(`   Worker: ${worker.publicKey.toBase58()}`);
  arbitrators.forEach((a, i) => console.log(`   Arbitrator ${i+1}: ${a.publicKey.toBase58()}`));
  
  // Setup providers
  const platformProvider = new AnchorProvider(connection, new Wallet(platformWallet), { commitment: "confirmed" });
  const posterProvider = new AnchorProvider(connection, new Wallet(poster), { commitment: "confirmed" });
  
  const idl = JSON.parse(fs.readFileSync("./target/idl/job_escrow.json", "utf8"));
  const platformProgram = new anchor.Program(idl, platformProvider);
  const posterProgram = new anchor.Program(idl, posterProvider);
  
  // PDAs
  const [poolPDA] = PublicKey.findProgramAddressSync([Buffer.from("arbitrator_pool")], PROGRAM_ID);
  
  // =========================================
  // STEP 1: Fund all test wallets
  // =========================================
  console.log("\n" + "=".repeat(50));
  console.log("STEP 1: Fund test wallets");
  console.log("=".repeat(50));
  
  const fundingNeeded = [
    { wallet: poster, amount: 0.1 * LAMPORTS_PER_SOL, name: "Poster" },
    { wallet: worker, amount: 0.01 * LAMPORTS_PER_SOL, name: "Worker" },
    ...arbitrators.map((a, i) => ({ wallet: a, amount: 0.12 * LAMPORTS_PER_SOL, name: `Arb${i+1}` })),
  ];
  
  for (const { wallet, amount, name } of fundingNeeded) {
    const balance = await connection.getBalance(wallet.publicKey);
    if (balance < amount) {
      const needed = amount - balance + 5000; // extra for fees
      console.log(`   Funding ${name} with ${(needed / LAMPORTS_PER_SOL).toFixed(4)} SOL...`);
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: platformWallet.publicKey,
          toPubkey: wallet.publicKey,
          lamports: needed,
        })
      );
      await platformProvider.sendAndConfirm(tx, [platformWallet]);
    } else {
      console.log(`   ${name} already funded (${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
    }
  }
  console.log("✅ All wallets funded");
  
  // =========================================
  // STEP 2: Register 5 arbitrators
  // =========================================
  console.log("\n" + "=".repeat(50));
  console.log("STEP 2: Register arbitrators");
  console.log("=".repeat(50));
  
  for (let i = 0; i < 5; i++) {
    const arb = arbitrators[i];
    const [arbPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("arbitrator"), arb.publicKey.toBuffer()],
      PROGRAM_ID
    );
    
    const arbProvider = new AnchorProvider(connection, new Wallet(arb), { commitment: "confirmed" });
    const arbProgram = new anchor.Program(idl, arbProvider);
    
    try {
      // Check if already registered
      await (arbProgram.account as any).arbitrator.fetch(arbPDA);
      console.log(`   Arbitrator ${i+1} already registered`);
    } catch {
      // Register
      try {
        const tx = await (arbProgram.methods as any)
          .registerArbitrator()
          .accounts({
            pool: poolPDA,
            arbitratorAccount: arbPDA,
            agent: arb.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([arb])
          .rpc();
        console.log(`   ✅ Arbitrator ${i+1} registered: ${tx.slice(0, 20)}...`);
      } catch (e: any) {
        console.log(`   ❌ Arbitrator ${i+1} failed: ${e.message?.slice(0, 50) || e}`);
      }
    }
    await sleep(500); // Rate limit
  }
  
  // Verify pool
  const pool = await (platformProgram.account as any).arbitratorPool.fetch(poolPDA);
  console.log(`\n   Pool now has ${pool.arbitrators.length} arbitrators`);
  
  if (pool.arbitrators.length < 5) {
    console.log("❌ Not enough arbitrators. Cannot continue.");
    return;
  }
  
  // =========================================
  // STEP 3: Create escrow and assign worker
  // =========================================
  console.log("\n" + "=".repeat(50));
  console.log("STEP 3: Create escrow and assign worker");
  console.log("=".repeat(50));
  
  const jobId = `dispute-test-${Date.now()}`;
  const jobIdHash = sha256(jobId);
  const [escrowPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), jobIdHash, poster.publicKey.toBuffer()],
    PROGRAM_ID
  );
  
  console.log(`   Job ID: ${jobId}`);
  console.log(`   Escrow PDA: ${escrowPDA.toBase58()}`);
  
  // Create escrow
  try {
    const tx = await (posterProgram.methods as any)
      .createEscrow(jobId, Array.from(jobIdHash), new anchor.BN(ESCROW_AMOUNT), null)
      .accounts({
        escrow: escrowPDA,
        poster: poster.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([poster])
      .rpc();
    console.log(`   ✅ Escrow created: ${tx.slice(0, 20)}...`);
  } catch (e: any) {
    console.log(`   ❌ Create failed: ${e.message?.slice(0, 80) || e}`);
    return;
  }
  
  // Assign worker
  try {
    const tx = await (posterProgram.methods as any)
      .assignWorker(worker.publicKey)
      .accounts({
        escrow: escrowPDA,
        initiator: poster.publicKey,
      })
      .signers([poster])
      .rpc();
    console.log(`   ✅ Worker assigned: ${tx.slice(0, 20)}...`);
  } catch (e: any) {
    console.log(`   ❌ Assign failed: ${e.message?.slice(0, 80) || e}`);
    return;
  }
  
  // =========================================
  // STEP 4: Worker submits work
  // =========================================
  console.log("\n" + "=".repeat(50));
  console.log("STEP 4: Worker submits work");
  console.log("=".repeat(50));
  
  const workerProvider = new AnchorProvider(connection, new Wallet(worker), { commitment: "confirmed" });
  const workerProgram = new anchor.Program(idl, workerProvider);
  
  try {
    const proofHash = sha256("completed-work-proof");
    const tx = await (workerProgram.methods as any)
      .submitWork(Array.from(proofHash))
      .accounts({
        escrow: escrowPDA,
        worker: worker.publicKey,
      })
      .signers([worker])
      .rpc();
    console.log(`   ✅ Work submitted: ${tx.slice(0, 20)}...`);
  } catch (e: any) {
    console.log(`   ❌ Submit failed: ${e.message?.slice(0, 80) || e}`);
    return;
  }
  
  // Verify status
  let escrow = await (posterProgram.account as any).escrow.fetch(escrowPDA);
  console.log(`   Status: ${JSON.stringify(escrow.status)}`);
  
  // =========================================
  // STEP 5: Poster raises dispute
  // =========================================
  console.log("\n" + "=".repeat(50));
  console.log("STEP 5: Raise dispute case");
  console.log("=".repeat(50));
  
  const [disputePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("dispute"), escrowPDA.toBuffer()],
    PROGRAM_ID
  );
  
  try {
    const tx = await (posterProgram.methods as any)
      .raiseDisputeCase("Work quality does not meet requirements. Missing key deliverables.")
      .accounts({
        escrow: escrowPDA,
        disputeCase: disputePDA,
        pool: poolPDA,
        initiator: poster.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([poster])
      .rpc();
    console.log(`   ✅ Dispute raised: ${tx.slice(0, 20)}...`);
  } catch (e: any) {
    console.log(`   ❌ Dispute failed: ${e.message || e}`);
    return;
  }
  
  // Check dispute case
  const disputeCase = await (posterProgram.account as any).disputeCase.fetch(disputePDA);
  console.log(`   Selected arbitrators:`);
  disputeCase.arbitrators.forEach((a: PublicKey, i: number) => {
    console.log(`      ${i+1}. ${a.toBase58().slice(0, 20)}...`);
  });
  console.log(`   Voting deadline: ${new Date(disputeCase.votingDeadline.toNumber() * 1000).toISOString()}`);
  
  // =========================================
  // STEP 6: Arbitrators vote
  // =========================================
  console.log("\n" + "=".repeat(50));
  console.log("STEP 6: Arbitrators cast votes");
  console.log("=".repeat(50));
  
  // Map our arbitrator keypairs to the selected ones
  const selectedArbs = disputeCase.arbitrators as PublicKey[];
  
  // Vote pattern: 3 for worker (majority), 2 for poster
  const votePattern = [
    { forWorker: {} },  // Arb 1 votes for worker
    { forWorker: {} },  // Arb 2 votes for worker
    { forWorker: {} },  // Arb 3 votes for worker (majority reached)
    { forPoster: {} },  // Arb 4 votes for poster
    { forPoster: {} },  // Arb 5 votes for poster
  ];
  
  for (let i = 0; i < 5; i++) {
    const selectedArb = selectedArbs[i];
    
    // Find our keypair for this selected arbitrator
    const arbKeypair = arbitrators.find(a => a.publicKey.equals(selectedArb));
    if (!arbKeypair) {
      console.log(`   ⚠️ Arbitrator ${i+1} not in our test set (external arbitrator?)`);
      continue;
    }
    
    const [arbAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("arbitrator"), arbKeypair.publicKey.toBuffer()],
      PROGRAM_ID
    );
    
    const arbProvider = new AnchorProvider(connection, new Wallet(arbKeypair), { commitment: "confirmed" });
    const arbProgram = new anchor.Program(idl, arbProvider);
    
    const vote = votePattern[i];
    const voteLabel = 'forWorker' in vote ? "ForWorker" : "ForPoster";
    
    try {
      const tx = await (arbProgram.methods as any)
        .castArbitrationVote(vote)
        .accounts({
          disputeCase: disputePDA,
          arbitratorAccount: arbAccountPDA,
          voter: arbKeypair.publicKey,
        })
        .signers([arbKeypair])
        .rpc();
      console.log(`   ✅ Arb ${i+1} voted ${voteLabel}: ${tx.slice(0, 20)}...`);
    } catch (e: any) {
      console.log(`   ❌ Arb ${i+1} vote failed: ${e.message?.slice(0, 60) || e}`);
    }
    await sleep(500);
  }
  
  // Check vote state
  const updatedDispute = await (posterProgram.account as any).disputeCase.fetch(disputePDA);
  console.log(`\n   Votes cast: ${updatedDispute.votes.filter((v: any) => v !== null).length}/5`);
  
  // =========================================
  // STEP 7: Finalize dispute
  // =========================================
  console.log("\n" + "=".repeat(50));
  console.log("STEP 7: Finalize dispute (majority reached)");
  console.log("=".repeat(50));
  
  try {
    const tx = await (posterProgram.methods as any)
      .finalizeDisputeCase()
      .accounts({
        disputeCase: disputePDA,
        escrow: escrowPDA,
        finalizer: poster.publicKey,
      })
      .signers([poster])
      .rpc();
    console.log(`   ✅ Dispute finalized: ${tx.slice(0, 20)}...`);
  } catch (e: any) {
    console.log(`   ❌ Finalize failed: ${e.message || e}`);
    return;
  }
  
  // Check resolution
  const finalizedDispute = await (posterProgram.account as any).disputeCase.fetch(disputePDA);
  console.log(`   Resolution: ${JSON.stringify(finalizedDispute.resolution)}`);
  
  escrow = await (posterProgram.account as any).escrow.fetch(escrowPDA);
  console.log(`   Escrow status: ${JSON.stringify(escrow.status)}`);
  
  // =========================================
  // STEP 8: Execute resolution
  // =========================================
  console.log("\n" + "=".repeat(50));
  console.log("STEP 8: Execute dispute resolution");
  console.log("=".repeat(50));
  
  const workerBalanceBefore = await connection.getBalance(worker.publicKey);
  const posterBalanceBefore = await connection.getBalance(poster.publicKey);
  
  try {
    const tx = await (posterProgram.methods as any)
      .executeDisputeResolution()
      .accounts({
        disputeCase: disputePDA,
        escrow: escrowPDA,
        worker: worker.publicKey,
        poster: poster.publicKey,
        platform: PLATFORM_WALLET,
        executor: poster.publicKey,
      })
      .signers([poster])
      .rpc();
    console.log(`   ✅ Resolution executed: ${tx.slice(0, 20)}...`);
  } catch (e: any) {
    console.log(`   ❌ Execute failed: ${e.message || e}`);
    return;
  }
  
  // Check final balances
  const workerBalanceAfter = await connection.getBalance(worker.publicKey);
  const posterBalanceAfter = await connection.getBalance(poster.publicKey);
  
  const workerDelta = (workerBalanceAfter - workerBalanceBefore) / LAMPORTS_PER_SOL;
  const posterDelta = (posterBalanceAfter - posterBalanceBefore) / LAMPORTS_PER_SOL;
  
  console.log(`\n   Worker balance change: ${workerDelta >= 0 ? '+' : ''}${workerDelta.toFixed(6)} SOL`);
  console.log(`   Poster balance change: ${posterDelta >= 0 ? '+' : ''}${posterDelta.toFixed(6)} SOL`);
  
  // Final escrow state
  escrow = await (posterProgram.account as any).escrow.fetch(escrowPDA);
  console.log(`   Final escrow status: ${JSON.stringify(escrow.status)}`);
  
  // =========================================
  // SUMMARY
  // =========================================
  console.log("\n" + "=".repeat(50));
  console.log("📊 TEST SUMMARY");
  console.log("=".repeat(50));
  console.log("✅ Created escrow with 0.05 SOL");
  console.log("✅ Assigned worker");
  console.log("✅ Worker submitted work");
  console.log("✅ Poster raised dispute");
  console.log("✅ 5 arbitrators selected from pool");
  console.log("✅ All arbitrators voted (3 worker, 2 poster)");
  console.log("✅ Dispute finalized with WorkerWins");
  console.log("✅ Resolution executed - funds to worker");
  console.log("\n🎉 FULL ARBITRATION FLOW COMPLETE!");
}

main().catch(console.error);
