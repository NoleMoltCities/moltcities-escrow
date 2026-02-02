import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { JobEscrow } from "../target/types/job_escrow";
import { Keypair, SystemProgram, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";

describe("Execute test", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.JobEscrow as Program<JobEscrow>;
  const PROGRAM_ID = program.programId;

  const sha256 = (data: string) => createHash('sha256').update(data).digest();

  it("full dispute flow with execute", async () => {
    // Setup
    const poster = Keypair.generate();
    const worker = Keypair.generate();
    const executor = Keypair.generate();
    
    // Fund accounts
    const sig1 = await provider.connection.requestAirdrop(poster.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig1);
    const sig2 = await provider.connection.requestAirdrop(worker.publicKey, LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig2);
    const sig3 = await provider.connection.requestAirdrop(executor.publicKey, LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig3);
    
    // Init pool
    const [poolPDA] = PublicKey.findProgramAddressSync([Buffer.from("arbitrator_pool")], PROGRAM_ID);
    try {
      await program.methods.initArbitratorPool().accounts({ authority: provider.wallet.publicKey }).rpc();
    } catch (e) {} // Pool may already exist
    
    // Register 3 arbitrators
    const arbs: Keypair[] = [];
    for (let i = 0; i < 3; i++) {
      const arb = Keypair.generate();
      arbs.push(arb);
      const sig = await provider.connection.requestAirdrop(arb.publicKey, LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
      await program.methods.registerArbitrator().accounts({ agent: arb.publicKey }).signers([arb]).rpc();
    }
    
    // Create escrow
    const jobId = `exec-test-${Date.now()}`;
    const jobIdHash = sha256(jobId);
    const [escrowPDA] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), jobIdHash, poster.publicKey.toBuffer()], PROGRAM_ID);
    const [disputePDA] = PublicKey.findProgramAddressSync([Buffer.from("dispute"), escrowPDA.toBuffer()], PROGRAM_ID);
    
    await program.methods
      .createEscrow(jobId, Array.from(jobIdHash), new anchor.BN(0.1 * LAMPORTS_PER_SOL), null)
      .accounts({ poster: poster.publicKey })
      .signers([poster])
      .rpc();
    
    // Assign and submit
    await program.methods.assignWorker(worker.publicKey).accounts({ escrow: escrowPDA, initiator: poster.publicKey }).signers([poster]).rpc();
    await program.methods.submitWork(Array.from(sha256("work"))).accounts({ escrow: escrowPDA, worker: worker.publicKey }).signers([worker]).rpc();
    
    // Raise dispute
    await program.methods.raiseDisputeCase("Test").accounts({ escrow: escrowPDA, initiator: poster.publicKey }).signers([poster]).rpc();
    
    // Vote - all for worker
    const dispute = await program.account.disputeCase.fetch(disputePDA);
    for (const arbPk of dispute.arbitrators) {
      const arb = arbs.find(a => a.publicKey.equals(arbPk));
      if (arb) {
        await program.methods.castArbitrationVote({ forWorker: {} }).accounts({ disputeCase: disputePDA, voter: arb.publicKey }).signers([arb]).rpc();
      }
    }
    
    // Finalize
    await program.methods.finalizeDisputeCase().accounts({ disputeCase: disputePDA, escrow: escrowPDA, finalizer: provider.wallet.publicKey }).rpc();
    
    // Init reputation for worker and poster
    await program.methods.initReputation().accounts({ agent: worker.publicKey }).rpc();
    await program.methods.initReputation().accounts({ agent: poster.publicKey }).rpc();
    
    const escrow = await program.account.escrow.fetch(escrowPDA);
    console.log("Escrow status before execute:", JSON.stringify(escrow.status));
    
    // Execute - THIS IS THE TEST
    const workerBefore = await provider.connection.getBalance(worker.publicKey);
    
    await program.methods
      .executeDisputeResolution()
      .accounts({
        disputeCase: disputePDA,
        escrow: escrowPDA,
        worker: worker.publicKey,
        poster: poster.publicKey,
        executor: executor.publicKey,
      })
      .signers([executor])
      .rpc();
    
    const workerAfter = await provider.connection.getBalance(worker.publicKey);
    console.log("Worker received:", (workerAfter - workerBefore) / LAMPORTS_PER_SOL, "SOL");
    
    const finalEscrow = await program.account.escrow.fetch(escrowPDA);
    console.log("Final status:", JSON.stringify(finalEscrow.status));
  });
});
