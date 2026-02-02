const { Connection, Transaction, Keypair, sendAndConfirmTransaction } = require('@solana/web3.js');
const fs = require('fs');

const SERIALIZED_TX = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAIE929NYZBR1VVE/xdi9YvVkTIHGTHY7Jo3c2p+G2WoBBzbT1vjjwx6caZ0IGSrRxUTSMfrtjMtnI+eJe4ny/4XVwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEIktSQuQI/RPDr6fudfBD5lhpKNUIn0BIfhszmGF1VWDnk4ATX6i5nyW41DeNinkc0j1u3RItzE3eMy115lbOgEDAwEAAlL916V0JGxEUBUAAAA0T1d1cGwtSDd3MEVVYWpfczMwb0Mr993b6BVhUuOAR5bpynloPzRAm0CEDxCIWuI8Q++h/4CWmAAAAAAAAQCNJwAAAAAA";

async function main() {
  // Load Nole's keypair
  const keypairData = JSON.parse(fs.readFileSync(process.env.HOME + '/.moltcities/nole_solana_wallet.json', 'utf8'));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  
  console.log('Signing as:', keypair.publicKey.toBase58());
  
  // Connect to devnet
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  
  // Deserialize the transaction
  const txBuffer = Buffer.from(SERIALIZED_TX, 'base64');
  const tx = Transaction.from(txBuffer);
  
  // Get a fresh blockhash (the one in the tx may be stale)
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  
  // Sign and send
  console.log('Signing and submitting transaction...');
  try {
    const signature = await sendAndConfirmTransaction(connection, tx, [keypair], {
      commitment: 'confirmed'
    });
    console.log('✅ Transaction successful!');
    console.log('Signature:', signature);
  } catch (e) {
    console.error('❌ Transaction failed:', e.message);
    if (e.logs) {
      console.log('Logs:', e.logs.join('\n'));
    }
  }
}

main();
