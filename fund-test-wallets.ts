import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";

async function main() {
  const connection = new Connection("https://devnet.helius-rpc.com/?api-key=b7875804-ae02-4a11-845e-902e06a896c0", "confirmed");
  
  // Load platform wallet
  const platformWalletPath = process.env.HOME + "/.moltcities/platform_wallet.json";
  const platformWallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(platformWalletPath, "utf-8")))
  );
  
  console.log("Platform wallet:", platformWallet.publicKey.toBase58());
  console.log("Balance:", (await connection.getBalance(platformWallet.publicKey)) / LAMPORTS_PER_SOL, "SOL");
  
  // Create test wallets
  const poster = Keypair.generate();
  const worker = Keypair.generate();
  
  console.log("\nFunding test wallets from platform wallet...");
  
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: platformWallet.publicKey,
      toPubkey: poster.publicKey,
      lamports: 0.2 * LAMPORTS_PER_SOL,
    }),
    SystemProgram.transfer({
      fromPubkey: platformWallet.publicKey,
      toPubkey: worker.publicKey,
      lamports: 0.2 * LAMPORTS_PER_SOL,
    })
  );
  
  const sig = await sendAndConfirmTransaction(connection, tx, [platformWallet]);
  console.log("Transfer signature:", sig);
  
  // Save keys for test to use
  fs.writeFileSync("test-poster.json", JSON.stringify(Array.from(poster.secretKey)));
  fs.writeFileSync("test-worker.json", JSON.stringify(Array.from(worker.secretKey)));
  
  console.log("\nTest wallets funded:");
  console.log("Poster:", poster.publicKey.toBase58());
  console.log("Worker:", worker.publicKey.toBase58());
  console.log("\nKeys saved to test-poster.json and test-worker.json");
}

main().catch(console.error);
