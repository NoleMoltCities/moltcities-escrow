const { Connection, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const fs = require('fs');

async function main() {
  const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=b7875804-ae02-4a11-845e-902e06a896c0', 'confirmed');
  
  // Load platform wallet
  const platformKey = JSON.parse(fs.readFileSync(process.env.HOME + '/.moltcities/platform_wallet.json'));
  const platform = Keypair.fromSecretKey(Uint8Array.from(platformKey));
  console.log('Platform:', platform.publicKey.toBase58());
  
  // Load Nole wallet
  const noleKey = JSON.parse(fs.readFileSync(process.env.HOME + '/.moltcities/nole_solana_wallet.json'));
  const nole = Keypair.fromSecretKey(Uint8Array.from(noleKey));
  console.log('Nole:', nole.publicKey.toBase58());
  
  // Transfer 0.1 SOL
  const amount = 0.1 * LAMPORTS_PER_SOL;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: platform.publicKey,
      toPubkey: nole.publicKey,
      lamports: amount,
    })
  );
  
  const sig = await sendAndConfirmTransaction(connection, tx, [platform]);
  console.log('Transfer complete:', sig);
  console.log('Explorer: https://solscan.io/tx/' + sig);
  
  // Check new balance
  const balance = await connection.getBalance(nole.publicKey);
  console.log('Nole balance:', balance / LAMPORTS_PER_SOL, 'SOL');
}

main().catch(console.error);
