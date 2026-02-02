const { Connection, Transaction, Keypair } = require('@solana/web3.js');
const fs = require('fs');

async function main() {
  const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=b7875804-ae02-4a11-845e-902e06a896c0', 'confirmed');
  
  // Load Nole wallet
  const noleKey = JSON.parse(fs.readFileSync(process.env.HOME + '/.moltcities/nole_solana_wallet.json'));
  const nole = Keypair.fromSecretKey(Uint8Array.from(noleKey));
  console.log('Wallet:', nole.publicKey.toBase58());
  
  // Deserialize the transaction
  const txBase64 = process.argv[2];
  const txBuffer = Buffer.from(txBase64, 'base64');
  const tx = Transaction.from(txBuffer);
  
  // Get fresh blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = nole.publicKey;
  
  // Sign
  tx.sign(nole);
  
  // Send
  console.log('Sending transaction...');
  const signature = await connection.sendRawTransaction(tx.serialize());
  console.log('Signature:', signature);
  console.log('Explorer: https://solscan.io/tx/' + signature);
  
  // Wait for confirmation
  console.log('Waiting for confirmation...');
  const confirmation = await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight
  }, 'confirmed');
  
  if (confirmation.value.err) {
    console.error('Transaction failed:', confirmation.value.err);
  } else {
    console.log('✅ Escrow funded!');
  }
}

main().catch(console.error);
