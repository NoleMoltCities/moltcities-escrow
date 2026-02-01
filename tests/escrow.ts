import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { JobEscrow } from "../target/types/job_escrow";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createHash } from "crypto";
import { expect } from "chai";

describe("job_escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.JobEscrow as Program<JobEscrow>;
  
  const PLATFORM_WALLET = new PublicKey("BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893");
  
  // Test wallets
  let poster: Keypair;
  let worker: Keypair;
  let arbitrator1: Keypair;
  let arbitrator2: Keypair;
  let arbitrator3: Keypair;
  let arbitrator4: Keypair;
  let arbitrator5: Keypair;
  
  // Helper to compute SHA256 hash
  function sha256(data: string): Buffer {
    return createHash('sha256').update(data).digest();
  }
  
  // Helper to find escrow PDA
  function findEscrowPDA(jobIdHash: Buffer, poster: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), jobIdHash, poster.toBuffer()],
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
  
  // Helper to find arbitrator pool PDA
  function findArbitratorPoolPDA(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("arbitrator_pool")],
      program.programId
    );
  }
  
  // Helper to find arbitrator PDA
  function findArbitratorPDA(agent: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("arbitrator"), agent.toBuffer()],
      program.programId
    );
  }
  
  // Helper to find dispute case PDA
  function findDisputeCasePDA(escrow: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("dispute"), escrow.toBuffer()],
      program.programId
    );
  }
  
  before(async () => {
    // Create test wallets
    poster = Keypair.generate();
    worker = Keypair.generate();
    arbitrator1 = Keypair.generate();
    arbitrator2 = Keypair.generate();
    arbitrator3 = Keypair.generate();
    arbitrator4 = Keypair.generate();
    arbitrator5 = Keypair.generate();
    
    // Fund wallets
    const airdropAmount = 2 * LAMPORTS_PER_SOL;
    for (const wallet of [poster, worker, arbitrator1, arbitrator2, arbitrator3, arbitrator4, arbitrator5]) {
      const sig = await provider.connection.requestAirdrop(wallet.publicKey, airdropAmount);
      await provider.connection.confirmTransaction(sig);
    }
  });
  
  describe("Phase 0: Basic Escrow", () => {
    const jobId = "test-job-001";
    const jobIdHash = sha256(jobId);
    let escrowPDA: PublicKey;
    
    it("creates an escrow", async () => {
      [escrowPDA] = findEscrowPDA(jobIdHash, poster.publicKey);
      const amount = new anchor.BN(0.1 * LAMPORTS_PER_SOL);
      
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
      expect(escrow.amount.toNumber()).to.equal(0.1 * LAMPORTS_PER_SOL);
      expect(escrow.status).to.deep.equal({ active: {} });
    });
    
    it("assigns a worker", async () => {
      await program.methods
        .assignWorker(worker.publicKey)
        .accounts({
          escrow: escrowPDA,
          initiator: poster.publicKey,
        })
        .signers([poster])
        .rpc();
      
      const escrow = await program.account.escrow.fetch(escrowPDA);
      expect(escrow.worker.equals(worker.publicKey)).to.be.true;
    });
    
    it("cancels escrow before worker assigned", async () => {
      // Create new escrow for cancel test
      const cancelJobId = "test-cancel-001";
      const cancelJobIdHash = sha256(cancelJobId);
      const [cancelEscrowPDA] = findEscrowPDA(cancelJobIdHash, poster.publicKey);
      
      await program.methods
        .createEscrow(cancelJobId, Array.from(cancelJobIdHash), new anchor.BN(0.05 * LAMPORTS_PER_SOL), null)
        .accounts({
          escrow: cancelEscrowPDA,
          poster: poster.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([poster])
        .rpc();
      
      await program.methods
        .cancelEscrow()
        .accounts({
          escrow: cancelEscrowPDA,
          poster: poster.publicKey,
        })
        .signers([poster])
        .rpc();
      
      const escrow = await program.account.escrow.fetch(cancelEscrowPDA);
      expect(escrow.status).to.deep.equal({ cancelled: {} });
    });
  });
  
  describe("Phase 1: Client-Must-Act Flow", () => {
    const jobId = "test-job-phase1";
    const jobIdHash = sha256(jobId);
    let escrowPDA: PublicKey;
    
    it("creates escrow and assigns worker", async () => {
      [escrowPDA] = findEscrowPDA(jobIdHash, poster.publicKey);
      
      await program.methods
        .createEscrow(jobId, Array.from(jobIdHash), new anchor.BN(0.1 * LAMPORTS_PER_SOL), null)
        .accounts({
          escrow: escrowPDA,
          poster: poster.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([poster])
        .rpc();
      
      await program.methods
        .assignWorker(worker.publicKey)
        .accounts({
          escrow: escrowPDA,
          initiator: poster.publicKey,
        })
        .signers([poster])
        .rpc();
    });
    
    it("worker submits work", async () => {
      const proofHash = sha256("proof-of-work-data");
      
      await program.methods
        .submitWork(Array.from(proofHash))
        .accounts({
          escrow: escrowPDA,
          worker: worker.publicKey,
        })
        .signers([worker])
        .rpc();
      
      const escrow = await program.account.escrow.fetch(escrowPDA);
      expect(escrow.status).to.deep.equal({ pendingReview: {} });
      expect(escrow.submittedAt).to.not.be.null;
    });
    
    it("poster approves work", async () => {
      const workerBalanceBefore = await provider.connection.getBalance(worker.publicKey);
      
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
      
      const escrow = await program.account.escrow.fetch(escrowPDA);
      expect(escrow.status).to.deep.equal({ released: {} });
      
      const workerBalanceAfter = await provider.connection.getBalance(worker.publicKey);
      const expectedPayment = 0.1 * LAMPORTS_PER_SOL * 0.99; // 99% after 1% platform fee
      expect(workerBalanceAfter - workerBalanceBefore).to.be.approximately(expectedPayment, 10000);
    });
  });
  
  describe("Phase 2: Reputation System", () => {
    it("initializes reputation for an agent", async () => {
      const [reputationPDA] = findReputationPDA(poster.publicKey);
      
      await program.methods
        .initReputation()
        .accounts({
          reputation: reputationPDA,
          agent: poster.publicKey,
          payer: poster.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([poster])
        .rpc();
      
      const reputation = await program.account.agentReputation.fetch(reputationPDA);
      expect(reputation.agent.equals(poster.publicKey)).to.be.true;
      expect(reputation.jobsCompleted.toNumber()).to.equal(0);
      expect(reputation.reputationScore.toNumber()).to.equal(0);
    });
    
    it("initializes reputation for worker", async () => {
      const [reputationPDA] = findReputationPDA(worker.publicKey);
      
      await program.methods
        .initReputation()
        .accounts({
          reputation: reputationPDA,
          agent: worker.publicKey,
          payer: worker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker])
        .rpc();
      
      const reputation = await program.account.agentReputation.fetch(reputationPDA);
      expect(reputation.agent.equals(worker.publicKey)).to.be.true;
    });
  });
  
  // Note: Phase 3 tests require platform authority which may not be available in test environment
  // These tests are commented out but show the expected flow
  
  /*
  describe("Phase 3: Multi-Arbitrator Disputes", () => {
    it("initializes arbitrator pool (platform only)", async () => {
      const [poolPDA] = findArbitratorPoolPDA();
      
      // This would require platform wallet as signer
      await program.methods
        .initArbitratorPool()
        .accounts({
          pool: poolPDA,
          authority: PLATFORM_WALLET,
          systemProgram: SystemProgram.programId,
        })
        .signers([platformWallet]) // Need platform keypair
        .rpc();
    });
    
    it("registers arbitrators", async () => {
      for (const arb of [arbitrator1, arbitrator2, arbitrator3, arbitrator4, arbitrator5]) {
        const [poolPDA] = findArbitratorPoolPDA();
        const [arbPDA] = findArbitratorPDA(arb.publicKey);
        
        await program.methods
          .registerArbitrator()
          .accounts({
            pool: poolPDA,
            arbitratorAccount: arbPDA,
            agent: arb.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([arb])
          .rpc();
      }
    });
    
    it("raises a dispute case", async () => {
      // Would need an escrow in PendingReview state
      // And 5 registered arbitrators
    });
    
    it("arbitrators vote", async () => {
      // Each arbitrator casts their vote
    });
    
    it("finalizes dispute", async () => {
      // After majority or deadline
    });
    
    it("executes resolution", async () => {
      // Funds distributed based on outcome
    });
  });
  */
});
