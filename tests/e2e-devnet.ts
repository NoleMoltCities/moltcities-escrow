/**
 * E2E Test Suite for MoltCities Escrow - Devnet
 * Tests against the deployed program without requiring airdrops
 * 
 * Run with: ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.moltcities/nole_solana_wallet.json yarn ts-mocha -p ./tsconfig.json -t 1000000 tests/e2e-devnet.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { JobEscrow } from "../target/types/job_escrow";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createHash } from "crypto";
import { expect } from "chai";
import * as fs from "fs";

describe("E2E Escrow Tests - Devnet", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.JobEscrow as Program<JobEscrow>;
  
  const PLATFORM_WALLET = new PublicKey("BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893");
  
  // Load the funder wallet (Nole)
  const funderKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(
      process.env.ANCHOR_WALLET || `${process.env.HOME}/.moltcities/nole_solana_wallet.json`, 
      'utf-8'
    )))
  );
  
  // Test wallets (generated fresh each run)
  let poster: Keypair;
  let worker: Keypair;
  
  // Helper to compute SHA256 hash
  function sha256(data: string): Buffer {
    return createHash('sha256').update(data).digest();
  }
  
  // Helper to find escrow PDA
  function findEscrowPDA(jobIdHash: Buffer, posterPk: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), jobIdHash, posterPk.toBuffer()],
      program.programId
    );
  }
  
  // Helper to find reputation PDA
  function findReputationPDA(agent: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("reputation"), agent.toBuffer()],
      program.programId
    );
  }
  
  // Fund a wallet from funder
  async function fundWallet(wallet: Keypair, amount: number): Promise<void> {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: funderKeypair.publicKey,
        toPubkey: wallet.publicKey,
        lamports: amount * LAMPORTS_PER_SOL,
      })
    );
    const sig = await sendAndConfirmTransaction(provider.connection, tx, [funderKeypair]);
    console.log(`  Funded ${wallet.publicKey.toString().slice(0,8)}... with ${amount} SOL: ${sig.slice(0,20)}...`);
  }
  
  before(async () => {
    console.log("\n=== Setup ===");
    console.log(`Program ID: ${program.programId.toString()}`);
    console.log(`Funder: ${funderKeypair.publicKey.toString()}`);
    
    // Check funder balance
    const funderBalance = await provider.connection.getBalance(funderKeypair.publicKey);
    console.log(`Funder balance: ${funderBalance / LAMPORTS_PER_SOL} SOL`);
    
    if (funderBalance < 0.5 * LAMPORTS_PER_SOL) {
      throw new Error("Funder wallet needs at least 0.5 SOL for tests");
    }
    
    // Create test wallets
    poster = Keypair.generate();
    worker = Keypair.generate();
    
    console.log(`Poster: ${poster.publicKey.toString()}`);
    console.log(`Worker: ${worker.publicKey.toString()}`);
    
    // Fund test wallets
    await fundWallet(poster, 0.15);
    await fundWallet(worker, 0.05);
    
    console.log("=== Setup Complete ===\n");
  });
  
  describe("Phase 1: Happy Path - Job to Payment", () => {
    const jobId = `e2e-test-${Date.now()}`;
    const jobIdHash = sha256(jobId);
    let escrowPDA: PublicKey;
    const escrowAmount = 0.05 * LAMPORTS_PER_SOL; // 0.05 SOL
    
    it("Step 1: Poster creates escrow with 0.05 SOL", async () => {
      [escrowPDA] = findEscrowPDA(jobIdHash, poster.publicKey);
      console.log(`  Job ID: ${jobId}`);
      console.log(`  Escrow PDA: ${escrowPDA.toString()}`);
      
      const amount = new anchor.BN(escrowAmount);
      
      await program.methods
        .createEscrow(jobId, Array.from(jobIdHash), amount, null)
        .accounts({
          escrow: escrowPDA,
          poster: poster.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([poster])
        .rpc();
      
      const escrow = await program.account.escrow.fetch(escrowPDA);
      expect(escrow.poster.equals(poster.publicKey)).to.be.true;
      expect(escrow.amount.toNumber()).to.equal(escrowAmount);
      expect(escrow.status).to.deep.equal({ active: {} });
      
      console.log(`  ✅ Escrow created with ${escrowAmount / LAMPORTS_PER_SOL} SOL`);
    });
    
    it("Step 2: Poster assigns worker", async () => {
      await program.methods
        .assignWorker(worker.publicKey)
        .accounts({
          escrow: escrowPDA,
          initiator: poster.publicKey,
        })
        .signers([poster])
        .rpc();
      
      const escrow = await program.account.escrow.fetch(escrowPDA);
      expect(escrow.worker?.equals(worker.publicKey)).to.be.true;
      // Status stays Active after assign, worker field is set
      expect(escrow.status).to.deep.equal({ active: {} });
      
      console.log(`  ✅ Worker assigned: ${worker.publicKey.toString().slice(0,8)}...`);
    });
    
    it("Step 3: Worker submits work with proof hash", async () => {
      const proofHash = sha256(`Work completed for ${jobId} at ${Date.now()}`);
      
      await program.methods
        .submitWork(Array.from(proofHash))
        .accounts({
          escrow: escrowPDA,
          worker: worker.publicKey,
        })
        .signers([worker])
        .rpc();
      
      const escrow = await program.account.escrow.fetch(escrowPDA);
      // Status changes to PendingReview after submit
      expect(escrow.status).to.deep.equal({ pendingReview: {} });
      expect(escrow.proofHash).to.deep.equal(Array.from(proofHash));
      
      console.log(`  ✅ Work submitted, status: PendingReview`);
    });
    
    it("Step 4: Poster approves work and releases payment", async () => {
      const workerBalanceBefore = await provider.connection.getBalance(worker.publicKey);
      const platformBalanceBefore = await provider.connection.getBalance(PLATFORM_WALLET);
      
      await program.methods
        .approveWork()
        .accounts({
          escrow: escrowPDA,
          poster: poster.publicKey,
          worker: worker.publicKey,
          platform: PLATFORM_WALLET,
        })
        .signers([poster])
        .rpc();
      
      const workerBalanceAfter = await provider.connection.getBalance(worker.publicKey);
      const platformBalanceAfter = await provider.connection.getBalance(PLATFORM_WALLET);
      
      // Worker should receive 99% (minus tiny rent if any)
      const workerReceived = workerBalanceAfter - workerBalanceBefore;
      const expectedWorkerAmount = escrowAmount * 0.99;
      expect(workerReceived).to.be.closeTo(expectedWorkerAmount, 10000); // Allow small margin
      
      // Platform should receive 1%
      const platformReceived = platformBalanceAfter - platformBalanceBefore;
      const expectedPlatformFee = escrowAmount * 0.01;
      expect(platformReceived).to.be.closeTo(expectedPlatformFee, 10000);
      
      // Escrow should be Released
      const escrow = await program.account.escrow.fetch(escrowPDA);
      expect(escrow.status).to.deep.equal({ released: {} });
      
      console.log(`  ✅ Payment released!`);
      console.log(`     Worker received: ${workerReceived / LAMPORTS_PER_SOL} SOL`);
      console.log(`     Platform fee: ${platformReceived / LAMPORTS_PER_SOL} SOL`);
    });
  });
  
  describe("Phase 2: Cancel Path - Poster Cancels Before Assignment", () => {
    const jobId = `e2e-cancel-${Date.now()}`;
    const jobIdHash = sha256(jobId);
    let escrowPDA: PublicKey;
    const escrowAmount = 0.03 * LAMPORTS_PER_SOL;
    
    it("Poster creates escrow", async () => {
      [escrowPDA] = findEscrowPDA(jobIdHash, poster.publicKey);
      
      await program.methods
        .createEscrow(jobId, Array.from(jobIdHash), new anchor.BN(escrowAmount), null)
        .accounts({
          escrow: escrowPDA,
          poster: poster.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([poster])
        .rpc();
      
      console.log(`  ✅ Escrow created for cancel test`);
    });
    
    it("Poster cancels and gets full amount back", async () => {
      const posterBalanceBefore = await provider.connection.getBalance(poster.publicKey);
      
      await program.methods
        .cancelEscrow()
        .accounts({
          escrow: escrowPDA,
          poster: poster.publicKey,
        })
        .signers([poster])
        .rpc();
      
      const posterBalanceAfter = await provider.connection.getBalance(poster.publicKey);
      
      // Poster should get back escrow amount minus transaction fee
      const posterReceived = posterBalanceAfter - posterBalanceBefore;
      expect(posterReceived).to.be.closeTo(escrowAmount, 10000); // Allow for tx fee
      
      const escrow = await program.account.escrow.fetch(escrowPDA);
      expect(escrow.status).to.deep.equal({ cancelled: {} });
      
      console.log(`  ✅ Cancel successful: ${posterReceived / LAMPORTS_PER_SOL} SOL returned`);
    });
  });
  
  after(async () => {
    console.log("\n=== Cleanup ===");
    // Return remaining funds to funder
    try {
      const posterBalance = await provider.connection.getBalance(poster.publicKey);
      if (posterBalance > 5000) {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: poster.publicKey,
            toPubkey: funderKeypair.publicKey,
            lamports: posterBalance - 5000, // Leave tiny amount for rent
          })
        );
        await sendAndConfirmTransaction(provider.connection, tx, [poster]);
        console.log(`  Returned ${(posterBalance - 5000) / LAMPORTS_PER_SOL} SOL from poster`);
      }
    } catch (e) {
      console.log(`  Could not return poster funds: ${e}`);
    }
    
    try {
      const workerBalance = await provider.connection.getBalance(worker.publicKey);
      if (workerBalance > 5000) {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: worker.publicKey,
            toPubkey: funderKeypair.publicKey,
            lamports: workerBalance - 5000,
          })
        );
        await sendAndConfirmTransaction(provider.connection, tx, [worker]);
        console.log(`  Returned ${(workerBalance - 5000) / LAMPORTS_PER_SOL} SOL from worker`);
      }
    } catch (e) {
      console.log(`  Could not return worker funds: ${e}`);
    }
    
    console.log("=== Tests Complete ===\n");
  });
});
