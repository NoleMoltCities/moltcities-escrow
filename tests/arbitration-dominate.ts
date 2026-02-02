/**
 * Arbitration Test - Dominate the pool with 50 arbitrators
 * This ensures we statistically get 3+ in any random selection
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { JobEscrow } from "../target/types/job_escrow";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction, Connection } from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const PLATFORM_WALLET = new PublicKey("BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893");
const PROGRAM_ID = new PublicKey("27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr");

const platformKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.moltcities/platform_wallet.json`, 'utf-8')))
);

const platformProvider = new AnchorProvider(connection, new Wallet(platformKeypair), { commitment: "confirmed" });
const idl = JSON.parse(fs.readFileSync("./target/idl/job_escrow.json", "utf8"));
const program = new anchor.Program(idl, platformProvider) as Program<JobEscrow>;

const [poolPDA] = PublicKey.findProgramAddressSync([Buffer.from("arbitrator_pool")], PROGRAM_ID);

function sha256(data: string): Buffer {
  return createHash('sha256').update(data).digest();
}

function findEscrowPDA(jobIdHash: Buffer, posterPk: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), jobIdHash, posterPk.toBuffer()],
    PROGRAM_ID
  );
}

function findArbitratorPDA(arbitrator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("arbitrator"), arbitrator.toBuffer()],
    PROGRAM_ID
  );
}

function findDisputeCasePDA(escrow: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("dispute"), escrow.toBuffer()],
    PROGRAM_ID
  );
}

async function fundWallet(wallet: Keypair, amount: number): Promise<void> {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: platformKeypair.publicKey,
      toPubkey: wallet.publicKey,
      lamports: amount * LAMPORTS_PER_SOL,
    })
  );
  await sendAndConfirmTransaction(connection, tx, [platformKeypair]);
}

async function main() {
  console.log("=== ARBITRATION DOMINANCE TEST ===\n");
  
  const balance = await connection.getBalance(platformKeypair.publicKey);
  console.log(`Platform balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  
  // Generate 50 arbitrators
  const NUM_ARBITRATORS = 50;
  console.log(`\nGenerating ${NUM_ARBITRATORS} arbitrators...`);
  const arbitrators: Keypair[] = [];
  for (let i = 0; i < NUM_ARBITRATORS; i++) {
    arbitrators.push(Keypair.generate());
  }
  
  // Save keypairs for future use
  const keypairsPath = `${process.env.HOME}/.moltcities/test_arbitrators.json`;
  fs.writeFileSync(keypairsPath, JSON.stringify(arbitrators.map(k => Array.from(k.secretKey))));
  console.log(`Saved keypairs to ${keypairsPath}`);
  
  // Fund and register
  console.log(`\nFunding and registering ${NUM_ARBITRATORS} arbitrators...`);
  let registered = 0;
  
  for (let i = 0; i < arbitrators.length; i++) {
    const arb = arbitrators[i];
    const [arbPDA] = findArbitratorPDA(arb.publicKey);
    
    // Check if exists
    const existing = await connection.getAccountInfo(arbPDA);
    if (existing) {
      console.log(`  Arb ${i+1}: already registered`);
      registered++;
      continue;
    }
    
    try {
      // Fund
      await fundWallet(arb, 0.12);
      
      // Register
      const arbProvider = new AnchorProvider(connection, new Wallet(arb), { commitment: "confirmed" });
      const arbProgram = new anchor.Program(idl, arbProvider) as Program<JobEscrow>;
      
      await arbProgram.methods
        .registerArbitrator()
        .accounts({
          arbitratorPool: poolPDA,
          arbitrator: arbPDA,
          agent: arb.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([arb])
        .rpc();
      
      registered++;
      if (registered % 10 === 0) {
        console.log(`  Progress: ${registered}/${NUM_ARBITRATORS} registered`);
      }
    } catch (e: any) {
      console.log(`  Arb ${i+1} failed: ${e.message.slice(0, 60)}`);
    }
  }
  
  console.log(`\n✅ Registered ${registered} arbitrators`);
  
  // Now test a dispute
  console.log("\n=== Testing Dispute Resolution ===");
  
  const poster = Keypair.generate();
  const worker = Keypair.generate();
  
  await fundWallet(poster, 0.15);
  await fundWallet(worker, 0.02);
  
  const jobId = `dominate-${Date.now()}`;
  const jobIdHash = sha256(jobId);
  const [escrowPDA] = findEscrowPDA(jobIdHash, poster.publicKey);
  const [disputePDA] = findDisputeCasePDA(escrowPDA);
  
  // Create escrow
  const posterProvider = new AnchorProvider(connection, new Wallet(poster), { commitment: "confirmed" });
  const posterProgram = new anchor.Program(idl, posterProvider) as Program<JobEscrow>;
  
  await posterProgram.methods
    .createEscrow(jobId, Array.from(jobIdHash), new anchor.BN(0.05 * LAMPORTS_PER_SOL), null)
    .accounts({
      escrow: escrowPDA,
      poster: poster.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([poster])
    .rpc();
  console.log("✅ Escrow created");
  
  // Assign + Submit
  await posterProgram.methods
    .assignWorker(worker.publicKey)
    .accounts({ escrow: escrowPDA, initiator: poster.publicKey })
    .signers([poster])
    .rpc();
  
  const workerProvider = new AnchorProvider(connection, new Wallet(worker), { commitment: "confirmed" });
  const workerProgram = new anchor.Program(idl, workerProvider) as Program<JobEscrow>;
  
  await workerProgram.methods
    .submitWork(Array.from(sha256("test")))
    .accounts({ escrow: escrowPDA, worker: worker.publicKey })
    .signers([worker])
    .rpc();
  console.log("✅ Work submitted");
  
  // Raise dispute
  await posterProgram.methods
    .raiseDisputeCase("Testing arbitration")
    .accounts({
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
  const disputeCase = await program.account.disputeCase.fetch(disputePDA);
  const selected = disputeCase.arbitrators as PublicKey[];
  
  console.log("\nSelected arbitrators:");
  selected.forEach((s, i) => console.log(`  ${i+1}: ${s.toString().slice(0,20)}...`));
  
  // Find ours
  const ours = arbitrators.filter(a => selected.some(s => s.equals(a.publicKey)));
  console.log(`\nOur arbitrators selected: ${ours.length}/5`);
  
  if (ours.length >= 3) {
    // Vote
    for (let i = 0; i < ours.length; i++) {
      const arb = ours[i];
      const [arbPDA] = findArbitratorPDA(arb.publicKey);
      const arbProvider = new AnchorProvider(connection, new Wallet(arb), { commitment: "confirmed" });
      const arbProgram = new anchor.Program(idl, arbProvider) as Program<JobEscrow>;
      
      await arbProgram.methods
        .castArbitrationVote({ forWorker: {} })
        .accounts({ disputeCase: disputePDA, arbitratorAccount: arbPDA, voter: arb.publicKey })
        .signers([arb])
        .rpc();
      console.log(`✅ Arb ${i+1} voted ForWorker`);
    }
    
    // Finalize
    await program.methods
      .finalizeDisputeCase()
      .accounts({ disputeCase: disputePDA, escrow: escrowPDA, finalizer: platformKeypair.publicKey })
      .signers([platformKeypair])
      .rpc();
    
    const escrow = await program.account.escrow.fetch(escrowPDA);
    console.log(`\n✅ DISPUTE FINALIZED: ${JSON.stringify(escrow.status)}`);
    
    // Execute
    const [posterRep] = PublicKey.findProgramAddressSync([Buffer.from("reputation"), poster.publicKey.toBuffer()], PROGRAM_ID);
    const [workerRep] = PublicKey.findProgramAddressSync([Buffer.from("reputation"), worker.publicKey.toBuffer()], PROGRAM_ID);
    
    await program.methods
      .executeDisputeResolution()
      .accounts({
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
    
    console.log("✅ RESOLUTION EXECUTED - Worker received funds!");
    
    const finalEscrow = await program.account.escrow.fetch(escrowPDA);
    console.log(`Final status: ${JSON.stringify(finalEscrow.status)}`);
  } else {
    console.log("\n❌ Not enough of our arbitrators selected. Need to register more or retry.");
  }
}

main().catch(console.error);
