/**
 * Simple Arbitration Test - JavaScript (no TypeScript issues)
 */

const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");
const { createHash } = require("crypto");
const fs = require("fs");

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const PLATFORM_WALLET = new PublicKey("BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893");
const PROGRAM_ID = new PublicKey("27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr");

const platformKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.moltcities/platform_wallet.json`, 'utf-8')))
);

const platformProvider = new anchor.AnchorProvider(connection, new anchor.Wallet(platformKeypair), { commitment: "confirmed" });
anchor.setProvider(platformProvider);

const idl = JSON.parse(fs.readFileSync("./target/idl/job_escrow.json", "utf8"));
const program = new anchor.Program(idl, platformProvider);

const [poolPDA] = PublicKey.findProgramAddressSync([Buffer.from("arbitrator_pool")], PROGRAM_ID);

function sha256(data) {
  return createHash('sha256').update(data).digest();
}

function findArbitratorPDA(pubkey) {
  return PublicKey.findProgramAddressSync([Buffer.from("arbitrator"), pubkey.toBuffer()], PROGRAM_ID);
}

function findEscrowPDA(jobIdHash, poster) {
  return PublicKey.findProgramAddressSync([Buffer.from("escrow"), jobIdHash, poster.toBuffer()], PROGRAM_ID);
}

function findDisputePDA(escrow) {
  return PublicKey.findProgramAddressSync([Buffer.from("dispute"), escrow.toBuffer()], PROGRAM_ID);
}

function findRepPDA(pubkey) {
  return PublicKey.findProgramAddressSync([Buffer.from("reputation"), pubkey.toBuffer()], PROGRAM_ID);
}

async function fundWallet(wallet, sol) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: platformKeypair.publicKey,
      toPubkey: wallet.publicKey,
      lamports: sol * LAMPORTS_PER_SOL,
    })
  );
  await sendAndConfirmTransaction(connection, tx, [platformKeypair]);
}

async function main() {
  console.log("=== ARBITRATION TEST ===\n");
  
  const balance = await connection.getBalance(platformKeypair.publicKey);
  console.log(`Platform balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  
  // Register 35 arbitrators (should dominate ~30 existing)
  const NUM_ARB = 35;
  console.log(`\nRegistering ${NUM_ARB} arbitrators...`);
  
  const arbitrators = [];
  let registered = 0;
  
  for (let i = 0; i < NUM_ARB; i++) {
    const arb = Keypair.generate();
    arbitrators.push(arb);
    const [arbPDA] = findArbitratorPDA(arb.publicKey);
    
    const existing = await connection.getAccountInfo(arbPDA);
    if (existing) {
      registered++;
      continue;
    }
    
    try {
      await fundWallet(arb, 0.12);
      
      const arbProvider = new anchor.AnchorProvider(connection, new anchor.Wallet(arb), { commitment: "confirmed" });
      const arbProgram = new anchor.Program(idl, arbProvider);
      
      await arbProgram.methods
        .registerArbitrator()
        .accountsStrict({
          arbitratorPool: poolPDA,
          arbitrator: arbPDA,
          agent: arb.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([arb])
        .rpc();
      
      registered++;
      if (registered % 5 === 0) console.log(`  ${registered}/${NUM_ARB}`);
    } catch (e) {
      // Pool might be full (100 max)
      console.log(`  Arb ${i+1} failed (pool may be full)`);
      break;
    }
  }
  
  console.log(`\nRegistered ${registered} arbitrators`);
  
  // Create test dispute
  console.log("\n=== Creating Dispute ===");
  
  const poster = Keypair.generate();
  const worker = Keypair.generate();
  await fundWallet(poster, 0.15);
  await fundWallet(worker, 0.02);
  
  const jobId = `arb-${Date.now()}`;
  const jobIdHash = sha256(jobId);
  const [escrowPDA] = findEscrowPDA(jobIdHash, poster.publicKey);
  const [disputePDA] = findDisputePDA(escrowPDA);
  
  const posterProvider = new anchor.AnchorProvider(connection, new anchor.Wallet(poster), { commitment: "confirmed" });
  const posterProgram = new anchor.Program(idl, posterProvider);
  
  // Create escrow
  await posterProgram.methods
    .createEscrow(jobId, Array.from(jobIdHash), new anchor.BN(0.05 * LAMPORTS_PER_SOL), null)
    .accountsStrict({
      escrow: escrowPDA,
      poster: poster.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([poster])
    .rpc();
  console.log("✅ Escrow created");
  
  // Assign worker
  await posterProgram.methods
    .assignWorker(worker.publicKey)
    .accountsStrict({
      escrow: escrowPDA,
      initiator: poster.publicKey,
    })
    .signers([poster])
    .rpc();
  
  // Submit work
  const workerProvider = new anchor.AnchorProvider(connection, new anchor.Wallet(worker), { commitment: "confirmed" });
  const workerProgram = new anchor.Program(idl, workerProvider);
  
  await workerProgram.methods
    .submitWork(Array.from(sha256("test work")))
    .accountsStrict({
      escrow: escrowPDA,
      worker: worker.publicKey,
    })
    .signers([worker])
    .rpc();
  console.log("✅ Work submitted");
  
  // Raise dispute
  await posterProgram.methods
    .raiseDisputeCase("Testing")
    .accountsStrict({
      escrow: escrowPDA,
      disputeCase: disputePDA,
      pool: poolPDA,
      initiator: poster.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([poster])
    .rpc();
  console.log("✅ Dispute raised");
  
  // Get selected arbitrators
  const dispute = await program.account.disputeCase.fetch(disputePDA);
  const selected = dispute.arbitrators;
  
  console.log("\nSelected arbitrators:");
  selected.forEach((s, i) => console.log(`  ${i+1}: ${s.toString().slice(0,16)}...`));
  
  // Find which of ours were selected
  const ours = arbitrators.filter(a => selected.some(s => s.equals(a.publicKey)));
  console.log(`\nOur arbitrators selected: ${ours.length}/5`);
  
  if (ours.length >= 3) {
    console.log("\n=== Voting ===");
    
    for (let i = 0; i < ours.length && i < 5; i++) {
      const arb = ours[i];
      const [arbPDA] = findArbitratorPDA(arb.publicKey);
      
      const arbProvider = new anchor.AnchorProvider(connection, new anchor.Wallet(arb), { commitment: "confirmed" });
      const arbProgram = new anchor.Program(idl, arbProvider);
      
      try {
        await arbProgram.methods
          .castArbitrationVote({ forWorker: {} })
          .accountsStrict({
            disputeCase: disputePDA,
            arbitratorAccount: arbPDA,
            voter: arb.publicKey,
          })
          .signers([arb])
          .rpc();
        console.log(`✅ Arb ${i+1} voted ForWorker`);
      } catch (e) {
        console.log(`⚠️ Vote failed: ${e.message.slice(0, 60)}`);
      }
    }
    
    // Finalize
    console.log("\n=== Finalizing ===");
    
    await program.methods
      .finalizeDisputeCase()
      .accountsStrict({
        disputeCase: disputePDA,
        escrow: escrowPDA,
        finalizer: platformKeypair.publicKey,
      })
      .signers([platformKeypair])
      .rpc();
    
    const escrowAfter = await program.account.escrow.fetch(escrowPDA);
    console.log(`✅ Finalized! Status: ${JSON.stringify(escrowAfter.status)}`);
    
    // Execute resolution
    const [posterRep] = findRepPDA(poster.publicKey);
    const [workerRep] = findRepPDA(worker.publicKey);
    
    const workerBefore = await connection.getBalance(worker.publicKey);
    
    await program.methods
      .executeDisputeResolution()
      .accountsStrict({
        disputeCase: disputePDA,
        escrow: escrowPDA,
        worker: worker.publicKey,
        poster: poster.publicKey,
        platform: PLATFORM_WALLET,
        workerReputation: workerRep,
        posterReputation: posterRep,
        executor: platformKeypair.publicKey,
      })
      .signers([platformKeypair])
      .rpc();
    
    const workerAfter = await connection.getBalance(worker.publicKey);
    const finalEscrow = await program.account.escrow.fetch(escrowPDA);
    
    console.log(`\n🎉 RESOLUTION EXECUTED!`);
    console.log(`   Final status: ${JSON.stringify(finalEscrow.status)}`);
    console.log(`   Worker received: ${(workerAfter - workerBefore) / LAMPORTS_PER_SOL} SOL`);
  } else {
    console.log("\n❌ Not enough arbitrators selected. Would need to retry or register more.");
    console.log("   (This is expected behavior - random selection may not always favor us)");
  }
}

main().catch(console.error);
