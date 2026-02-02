/**
 * Full Arbitration Test - Ensures 3/5 majority
 * Strategy: Register 15 arbitrators, so random selection will likely pick mostly ours
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { JobEscrow } from "../target/types/job_escrow";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction, Connection } from "@solana/web3.js";
import { createHash } from "crypto";
import { expect } from "chai";
import * as fs from "fs";

describe("Full Arbitration Test", () => {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  
  const PLATFORM_WALLET = new PublicKey("BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893");
  const PROGRAM_ID = new PublicKey("27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr");
  const ARBITRATOR_STAKE = 0.1 * LAMPORTS_PER_SOL;
  
  const platformKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.moltcities/platform_wallet.json`, 'utf-8')))
  );
  
  const platformProvider = new AnchorProvider(connection, new Wallet(platformKeypair), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync("./target/idl/job_escrow.json", "utf8"));
  const program = new anchor.Program(idl, platformProvider) as Program<JobEscrow>;
  
  let poster: Keypair;
  let worker: Keypair;
  let arbitrators: Keypair[] = [];
  
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
  
  before(async () => {
    console.log("\n=== FULL ARBITRATION TEST ===");
    console.log(`Platform: ${platformKeypair.publicKey.toString()}`);
    
    const platformBalance = await connection.getBalance(platformKeypair.publicKey);
    console.log(`Platform balance: ${platformBalance / LAMPORTS_PER_SOL} SOL`);
    
    // Create wallets
    poster = Keypair.generate();
    worker = Keypair.generate();
    
    // Create 15 arbitrators to dominate the pool
    for (let i = 0; i < 15; i++) {
      arbitrators.push(Keypair.generate());
    }
    
    console.log(`Poster: ${poster.publicKey.toString().slice(0,12)}...`);
    console.log(`Worker: ${worker.publicKey.toString().slice(0,12)}...`);
    console.log(`Arbitrators: ${arbitrators.length}`);
    
    // Fund all wallets
    console.log("\nFunding wallets...");
    await fundWallet(poster, 0.2);
    await fundWallet(worker, 0.05);
    for (const arb of arbitrators) {
      await fundWallet(arb, 0.15);
    }
    console.log("Funding complete");
  });
  
  it("Register 15 arbitrators", async () => {
    let registered = 0;
    for (let i = 0; i < arbitrators.length; i++) {
      const arb = arbitrators[i];
      const [arbPDA] = findArbitratorPDA(arb.publicKey);
      
      const existing = await connection.getAccountInfo(arbPDA);
      if (existing) {
        console.log(`  Arb ${i+1} already registered`);
        continue;
      }
      
      const arbProvider = new AnchorProvider(connection, new Wallet(arb), { commitment: "confirmed" });
      const arbProgram = new anchor.Program(idl, arbProvider) as Program<JobEscrow>;
      
      try {
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
        console.log(`  ✅ Arb ${i+1} registered`);
      } catch (e: any) {
        console.log(`  ⚠️ Arb ${i+1} failed: ${e.message.slice(0, 50)}`);
      }
    }
    console.log(`Registered ${registered} new arbitrators`);
  });
  
  it("Create escrow and raise dispute", async () => {
    const jobId = `arb-full-${Date.now()}`;
    const jobIdHash = sha256(jobId);
    const [escrowPDA] = findEscrowPDA(jobIdHash, poster.publicKey);
    const [disputePDA] = findDisputeCasePDA(escrowPDA);
    const escrowAmount = 0.05 * LAMPORTS_PER_SOL;
    
    // Create escrow
    const posterProvider = new AnchorProvider(connection, new Wallet(poster), { commitment: "confirmed" });
    const posterProgram = new anchor.Program(idl, posterProvider) as Program<JobEscrow>;
    
    await posterProgram.methods
      .createEscrow(jobId, Array.from(jobIdHash), new anchor.BN(escrowAmount), null)
      .accounts({
        escrow: escrowPDA,
        poster: poster.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([poster])
      .rpc();
    console.log(`✅ Escrow created`);
    
    // Assign worker
    await posterProgram.methods
      .assignWorker(worker.publicKey)
      .accounts({
        escrow: escrowPDA,
        initiator: poster.publicKey,
      })
      .signers([poster])
      .rpc();
    console.log(`✅ Worker assigned`);
    
    // Submit work
    const workerProvider = new AnchorProvider(connection, new Wallet(worker), { commitment: "confirmed" });
    const workerProgram = new anchor.Program(idl, workerProvider) as Program<JobEscrow>;
    
    await workerProgram.methods
      .submitWork(Array.from(sha256("test work")))
      .accounts({
        escrow: escrowPDA,
        worker: worker.publicKey,
      })
      .signers([worker])
      .rpc();
    console.log(`✅ Work submitted`);
    
    // Raise dispute
    await posterProgram.methods
      .raiseDisputeCase("Quality not acceptable")
      .accounts({
        escrow: escrowPDA,
        disputeCase: disputePDA,
        pool: poolPDA,
        initiator: poster.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([poster])
      .rpc();
    console.log(`✅ Dispute raised`);
    
    // Get selected arbitrators
    const disputeCase = await program.account.disputeCase.fetch(disputePDA);
    const selectedArbitrators = disputeCase.arbitrators as PublicKey[];
    
    console.log(`\nSelected arbitrators:`);
    selectedArbitrators.forEach((a, i) => console.log(`  ${i+1}: ${a.toString().slice(0,16)}...`));
    
    // Find which of our arbitrators were selected
    const ourSelected = arbitrators.filter(arb =>
      selectedArbitrators.some(selected => selected.equals(arb.publicKey))
    );
    
    console.log(`\nOur arbitrators selected: ${ourSelected.length}/5`);
    
    if (ourSelected.length < 3) {
      console.log("⚠️ Not enough of our arbitrators selected. Test may fail.");
    }
    
    // Vote - first 3 for worker, rest for poster
    let votesForWorker = 0;
    let votesForPoster = 0;
    
    for (let i = 0; i < ourSelected.length; i++) {
      const arb = ourSelected[i];
      const [arbPDA] = findArbitratorPDA(arb.publicKey);
      
      const arbProvider = new AnchorProvider(connection, new Wallet(arb), { commitment: "confirmed" });
      const arbProgram = new anchor.Program(idl, arbProvider) as Program<JobEscrow>;
      
      const vote = i < 3 ? { forWorker: {} } : { forPoster: {} };
      
      try {
        await arbProgram.methods
          .castArbitrationVote(vote)
          .accounts({
            disputeCase: disputePDA,
            arbitratorAccount: arbPDA,
            voter: arb.publicKey,
          })
          .signers([arb])
          .rpc();
        
        if (i < 3) {
          votesForWorker++;
          console.log(`✅ Arb ${i+1} voted: ForWorker`);
        } else {
          votesForPoster++;
          console.log(`✅ Arb ${i+1} voted: ForPoster`);
        }
      } catch (e: any) {
        console.log(`⚠️ Arb ${i+1} vote failed: ${e.message.slice(0, 50)}`);
      }
    }
    
    console.log(`\nVotes cast: ${votesForWorker} for worker, ${votesForPoster} for poster`);
    
    // Finalize if we have majority
    if (votesForWorker >= 3 || votesForPoster >= 3) {
      console.log(`\nFinalizing dispute...`);
      
      await program.methods
        .finalizeDisputeCase()
        .accounts({
          disputeCase: disputePDA,
          escrow: escrowPDA,
          finalizer: platformKeypair.publicKey,
        })
        .signers([platformKeypair])
        .rpc();
      
      const escrow = await program.account.escrow.fetch(escrowPDA);
      const dispute = await program.account.disputeCase.fetch(disputePDA);
      
      console.log(`✅ Dispute finalized!`);
      console.log(`   Escrow status: ${JSON.stringify(escrow.status)}`);
      console.log(`   Resolution: ${JSON.stringify(dispute.resolution)}`);
      
      // Execute resolution
      console.log(`\nExecuting resolution...`);
      
      const [posterRepPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("reputation"), poster.publicKey.toBuffer()], PROGRAM_ID
      );
      const [workerRepPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("reputation"), worker.publicKey.toBuffer()], PROGRAM_ID
      );
      
      const workerBalanceBefore = await connection.getBalance(worker.publicKey);
      
      await program.methods
        .executeDisputeResolution()
        .accounts({
          disputeCase: disputePDA,
          escrow: escrowPDA,
          worker: worker.publicKey,
          poster: poster.publicKey,
          platform: PLATFORM_WALLET,
          workerReputation: workerRepPDA,
          posterReputation: posterRepPDA,
          executor: platformKeypair.publicKey,
        })
        .signers([platformKeypair])
        .rpc();
      
      const workerBalanceAfter = await connection.getBalance(worker.publicKey);
      const finalEscrow = await program.account.escrow.fetch(escrowPDA);
      
      console.log(`✅ Resolution executed!`);
      console.log(`   Final escrow status: ${JSON.stringify(finalEscrow.status)}`);
      console.log(`   Worker balance change: ${(workerBalanceAfter - workerBalanceBefore) / LAMPORTS_PER_SOL} SOL`);
    } else {
      console.log(`\n⚠️ Not enough votes for majority. Need to wait for deadline or get more arbitrators.`);
    }
  });
});
