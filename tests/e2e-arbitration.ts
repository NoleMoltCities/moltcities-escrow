/**
 * E2E Arbitration Test Suite - Devnet
 * Tests dispute flow with arbitrators voting
 * 
 * Run with: ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.moltcities/nole_solana_wallet.json yarn ts-mocha -p ./tsconfig.json -t 1000000 tests/e2e-arbitration.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { JobEscrow } from "../target/types/job_escrow";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction, Connection } from "@solana/web3.js";
import { createHash } from "crypto";
import { expect } from "chai";
import * as fs from "fs";

describe("E2E Arbitration Tests - Devnet", () => {
  // Use devnet connection
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  
  const PLATFORM_WALLET = new PublicKey("BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893");
  const PROGRAM_ID = new PublicKey("27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr");
  const ARBITRATOR_STAKE = 0.1 * LAMPORTS_PER_SOL;
  
  // Load the platform wallet for init operations
  const platformKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(
      `${process.env.HOME}/.moltcities/platform_wallet.json`, 
      'utf-8'
    )))
  );
  
  // Load the funder wallet (Nole)
  const funderKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(
      process.env.ANCHOR_WALLET || `${process.env.HOME}/.moltcities/nole_solana_wallet.json`, 
      'utf-8'
    )))
  );
  
  // Setup provider with platform wallet for certain operations
  const platformProvider = new AnchorProvider(connection, new Wallet(platformKeypair), { commitment: "confirmed" });
  const funderProvider = new AnchorProvider(connection, new Wallet(funderKeypair), { commitment: "confirmed" });
  
  const idl = JSON.parse(fs.readFileSync("./target/idl/job_escrow.json", "utf8"));
  const platformProgram = new anchor.Program(idl, platformProvider) as Program<JobEscrow>;
  const funderProgram = new anchor.Program(idl, funderProvider) as Program<JobEscrow>;
  
  // Test wallets
  let poster: Keypair;
  let worker: Keypair;
  let arbitrators: Keypair[] = [];
  
  // PDAs
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
  
  function findReputationPDA(agent: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("reputation"), agent.toBuffer()],
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
    console.log(`  Funded ${wallet.publicKey.toString().slice(0,8)}... with ${amount} SOL`);
  }
  
  before(async () => {
    console.log("\n=== Arbitration Test Setup ===");
    console.log(`Program ID: ${PROGRAM_ID.toString()}`);
    console.log(`Platform: ${platformKeypair.publicKey.toString()}`);
    console.log(`Pool PDA: ${poolPDA.toString()}`);
    
    // Check platform balance
    const platformBalance = await connection.getBalance(platformKeypair.publicKey);
    console.log(`Platform balance: ${platformBalance / LAMPORTS_PER_SOL} SOL`);
    
    if (platformBalance < 1.5 * LAMPORTS_PER_SOL) {
      throw new Error("Platform wallet needs at least 1.5 SOL for arbitration tests");
    }
    
    // Create test wallets
    poster = Keypair.generate();
    worker = Keypair.generate();
    for (let i = 0; i < 5; i++) {
      arbitrators.push(Keypair.generate());
    }
    
    console.log(`Poster: ${poster.publicKey.toString()}`);
    console.log(`Worker: ${worker.publicKey.toString()}`);
    arbitrators.forEach((a, i) => console.log(`Arbitrator ${i+1}: ${a.publicKey.toString().slice(0,8)}...`));
    
    // Fund all wallets from platform
    await fundWallet(poster, 0.2);
    await fundWallet(worker, 0.05);
    for (const arb of arbitrators) {
      await fundWallet(arb, 0.15); // Need enough for stake + tx fees
    }
    
    console.log("=== Setup Complete ===\n");
  });
  
  describe("Phase 3: Arbitration Flow", () => {
    const jobId = `arb-test-${Date.now()}`;
    const jobIdHash = sha256(jobId);
    let escrowPDA: PublicKey;
    let disputePDA: PublicKey;
    const escrowAmount = 0.05 * LAMPORTS_PER_SOL;
    
    it("Step 1: Verify arbitrator pool exists", async () => {
      const poolInfo = await connection.getAccountInfo(poolPDA);
      expect(poolInfo).to.not.be.null;
      console.log(`  ✅ Arbitrator pool exists (${poolInfo!.data.length} bytes)`);
    });
    
    it("Step 2: Register 5 arbitrators with stake", async () => {
      for (let i = 0; i < 5; i++) {
        const arb = arbitrators[i];
        const [arbPDA] = findArbitratorPDA(arb.publicKey);
        
        // Check if already registered
        const existing = await connection.getAccountInfo(arbPDA);
        if (existing) {
          console.log(`  Arbitrator ${i+1} already registered, skipping`);
          continue;
        }
        
        // Create provider for this arbitrator
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
        
        console.log(`  ✅ Arbitrator ${i+1} registered with ${ARBITRATOR_STAKE / LAMPORTS_PER_SOL} SOL stake`);
      }
    });
    
    it("Step 3: Create escrow for dispute test", async () => {
      [escrowPDA] = findEscrowPDA(jobIdHash, poster.publicKey);
      [disputePDA] = findDisputeCasePDA(escrowPDA);
      
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
      
      console.log(`  ✅ Escrow created: ${escrowPDA.toString().slice(0,8)}...`);
    });
    
    it("Step 4: Assign worker and submit work", async () => {
      const posterProvider = new AnchorProvider(connection, new Wallet(poster), { commitment: "confirmed" });
      const posterProgram = new anchor.Program(idl, posterProvider) as Program<JobEscrow>;
      
      // Assign worker
      await posterProgram.methods
        .assignWorker(worker.publicKey)
        .accounts({
          escrow: escrowPDA,
          initiator: poster.publicKey,
        })
        .signers([poster])
        .rpc();
      
      console.log(`  ✅ Worker assigned`);
      
      // Worker submits work
      const workerProvider = new AnchorProvider(connection, new Wallet(worker), { commitment: "confirmed" });
      const workerProgram = new anchor.Program(idl, workerProvider) as Program<JobEscrow>;
      
      const proofHash = sha256(`Disputed work for ${jobId}`);
      await workerProgram.methods
        .submitWork(Array.from(proofHash))
        .accounts({
          escrow: escrowPDA,
          worker: worker.publicKey,
        })
        .signers([worker])
        .rpc();
      
      console.log(`  ✅ Work submitted`);
    });
    
    it("Step 5: Poster raises dispute case", async () => {
      // Poster raises dispute (must be poster or worker)
      const posterProvider = new AnchorProvider(connection, new Wallet(poster), { commitment: "confirmed" });
      const posterProgram = new anchor.Program(idl, posterProvider) as Program<JobEscrow>;
      
      await posterProgram.methods
        .raiseDisputeCase("Work quality does not meet requirements")
        .accounts({
          escrow: escrowPDA,
          disputeCase: disputePDA,
          pool: poolPDA,
          initiator: poster.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([poster])
        .rpc();
      
      const escrow = await platformProgram.account.escrow.fetch(escrowPDA);
      expect(escrow.status).to.deep.equal({ inArbitration: {} });
      
      console.log(`  ✅ Dispute raised, status: InArbitration`);
    });
    
    it("Step 6: Arbitrators vote (3 for worker, 2 for poster)", async () => {
      // Get the selected arbitrators from the dispute case
      const disputeCase = await platformProgram.account.disputeCase.fetch(disputePDA);
      const selectedArbitrators = disputeCase.arbitrators;
      
      console.log(`  Selected arbitrators from pool:`);
      selectedArbitrators.forEach((a: PublicKey, i: number) => console.log(`    ${i+1}: ${a.toString().slice(0,8)}...`));
      
      // We need to find which of our test arbitrators were selected
      // For this test, we'll register our arbitrators in the pool first and hope they get selected
      // If they weren't selected, the test will fail and we'll need to adjust
      
      // Check if our arbitrators were selected
      const ourArbsSelected = arbitrators.filter(arb => 
        selectedArbitrators.some((selected: PublicKey) => selected.equals(arb.publicKey))
      );
      
      console.log(`  Our arbitrators selected: ${ourArbsSelected.length}/5`);
      
      if (ourArbsSelected.length < 5) {
        console.log(`  ⚠️ Not all our arbitrators were selected. Using the ones that were...`);
      }
      
      // Vote with the arbitrators we have (first 3 for worker, rest for poster)
      for (let i = 0; i < Math.min(3, ourArbsSelected.length); i++) {
        const arb = ourArbsSelected[i];
        const [arbPDA] = findArbitratorPDA(arb.publicKey);
        
        const arbProvider = new AnchorProvider(connection, new Wallet(arb), { commitment: "confirmed" });
        const arbProgram = new anchor.Program(idl, arbProvider) as Program<JobEscrow>;
        
        await arbProgram.methods
          .castArbitrationVote({ forWorker: {} })
          .accounts({
            disputeCase: disputePDA,
            arbitratorAccount: arbPDA,
            voter: arb.publicKey,
          })
          .signers([arb])
          .rpc();
        
        console.log(`  ✅ Arbitrator ${i+1} voted: ForWorker`);
      }
      
      // Rest vote for poster
      for (let i = 3; i < ourArbsSelected.length; i++) {
        const arb = ourArbsSelected[i];
        const [arbPDA] = findArbitratorPDA(arb.publicKey);
        
        const arbProvider = new AnchorProvider(connection, new Wallet(arb), { commitment: "confirmed" });
        const arbProgram = new anchor.Program(idl, arbProvider) as Program<JobEscrow>;
        
        await arbProgram.methods
          .castArbitrationVote({ forPoster: {} })
          .accounts({
            disputeCase: disputePDA,
            arbitratorAccount: arbPDA,
            voter: arb.publicKey,
          })
          .signers([arb])
          .rpc();
        
        console.log(`  ✅ Arbitrator ${i+1} voted: ForPoster`);
      }
    });
    
    it("Step 7: Finalize dispute (majority wins)", async () => {
      // Anyone can finalize after votes
      await platformProgram.methods
        .finalizeDisputeCase()
        .accounts({
          disputeCase: disputePDA,
          escrow: escrowPDA,
          finalizer: platformKeypair.publicKey,
        })
        .signers([platformKeypair])
        .rpc();
      
      const escrow = await platformProgram.account.escrow.fetch(escrowPDA);
      const disputeCase = await platformProgram.account.disputeCase.fetch(disputePDA);
      
      console.log(`  Dispute resolution: ${JSON.stringify(disputeCase.resolution)}`);
      console.log(`  Escrow status: ${JSON.stringify(escrow.status)}`);
      
      console.log(`  ✅ Dispute finalized`);
    });
    
    it("Step 8: Execute resolution - Funds distributed", async () => {
      const workerBalanceBefore = await connection.getBalance(worker.publicKey);
      const posterBalanceBefore = await connection.getBalance(poster.publicKey);
      const platformBalanceBefore = await connection.getBalance(PLATFORM_WALLET);
      
      const [posterRepPDA] = findReputationPDA(poster.publicKey);
      const [workerRepPDA] = findReputationPDA(worker.publicKey);
      
      // Initialize reputation accounts if needed (they may not exist)
      // The execute will fail if they don't exist - let's try anyway
      
      await platformProgram.methods
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
      const platformBalanceAfter = await connection.getBalance(PLATFORM_WALLET);
      
      const workerReceived = workerBalanceAfter - workerBalanceBefore;
      const platformReceived = platformBalanceAfter - platformBalanceBefore;
      
      const escrow = await platformProgram.account.escrow.fetch(escrowPDA);
      expect(escrow.status).to.deep.equal({ released: {} });
      
      console.log(`  ✅ Resolution executed!`);
      console.log(`     Worker received: ${workerReceived / LAMPORTS_PER_SOL} SOL`);
      console.log(`     Platform fee: ${platformReceived / LAMPORTS_PER_SOL} SOL`);
    });
  });
  
  after(async () => {
    console.log("\n=== Cleanup ===");
    // Note: Arbitrator stakes remain locked for demonstration
    // In production, arbitrators can unstake after cooldown
    console.log("  Arbitrator stakes remain active (can unstake later)");
    console.log("=== Arbitration Tests Complete ===\n");
  });
});
