//! CreateTokenEscrow instruction
//!
//! Creates a new escrow account for SPL tokens and deposits tokens.

use pinocchio::{
    account_info::AccountInfo,
    instruction::Signer,
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    seeds,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::instructions::Transfer as TokenTransfer;

use crate::{
    errors::EscrowError,
    state::{JobEscrow, EscrowStatus},
    require,
};

/// Minimum token escrow amount (1 token unit - actual minimum depends on decimals)
pub const MIN_TOKEN_ESCROW_AMOUNT: u64 = 1;

// Use DEFAULT_EXPIRY_SECONDS from create_escrow
use super::create_escrow::DEFAULT_EXPIRY_SECONDS;

/// Create token escrow instruction accounts
/// Accounts:
/// 0. escrow (PDA, writable)
/// 1. poster (signer, writable)
/// 2. token_mint (readonly)
/// 3. poster_token_account (writable) - poster's ATA for the token
/// 4. escrow_token_account (writable) - escrow's ATA for the token
/// 5. system_program
/// 6. token_program
pub struct CreateTokenEscrowAccounts<'a> {
    pub escrow: &'a AccountInfo,
    pub poster: &'a AccountInfo,
    pub token_mint: &'a AccountInfo,
    pub poster_token_account: &'a AccountInfo,
    pub escrow_token_account: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
    pub token_program: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for CreateTokenEscrowAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [escrow, poster, token_mint, poster_token_account, escrow_token_account, system_program, token_program, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        // Poster must be signer
        if !poster.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        // Verify token program ID
        let expected_token_program: Pubkey = [
            0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93,
            0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79, 0xac,
            0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91,
            0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff, 0x00, 0xa9,
        ]; // TokenkegQEcLiukSpvdP3kMR6CYjQLTdM9TBgmYABBmL
        if token_program.key() != &expected_token_program {
            return Err(ProgramError::IncorrectProgramId);
        }

        Ok(Self {
            escrow,
            poster,
            token_mint,
            poster_token_account,
            escrow_token_account,
            system_program,
            token_program,
        })
    }
}

/// Instruction data for CreateTokenEscrow
/// Layout: [job_id_hash: [u8; 32], amount: u64, expiry_seconds: i64 (0 = default)]
pub struct CreateTokenEscrowData {
    pub job_id_hash: [u8; 32],
    pub amount: u64,
    pub expiry_seconds: i64,
}

impl CreateTokenEscrowData {
    pub fn try_from_slice(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 48 {
            return Err(ProgramError::InvalidInstructionData);
        }
        
        let job_id_hash: [u8; 32] = data[0..32].try_into().unwrap();
        let amount = u64::from_le_bytes(data[32..40].try_into().unwrap());
        let expiry_seconds = i64::from_le_bytes(data[40..48].try_into().unwrap());
        
        Ok(Self {
            job_id_hash,
            amount,
            expiry_seconds,
        })
    }
}

/// Process create_token_escrow instruction
pub fn process_create_token_escrow(
    accounts: &[AccountInfo],
    data: &[u8],
    program_id: &Pubkey,
) -> ProgramResult {
    let ctx = CreateTokenEscrowAccounts::try_from(accounts)?;
    let args = CreateTokenEscrowData::try_from_slice(data)?;

    // Validate amount
    require!(args.amount >= MIN_TOKEN_ESCROW_AMOUNT, EscrowError::AmountTooLow);

    // Get clock for timestamps
    let clock = Clock::get()?;
    
    // Calculate expiry
    let expiry = if args.expiry_seconds > 0 {
        args.expiry_seconds
    } else {
        DEFAULT_EXPIRY_SECONDS
    };
    require!(expiry > 0, EscrowError::InvalidExpiry);

    // Derive PDA and verify
    let (expected_pda, bump) = find_program_address(
        &[b"escrow", &args.job_id_hash, ctx.poster.key()],
        program_id,
    );
    
    if ctx.escrow.key() != &expected_pda {
        return Err(EscrowError::InvalidPda.into());
    }

    // Calculate rent for escrow account (no lamports needed for token, just rent)
    let rent = Rent::get()?;
    let rent_lamports = rent.minimum_balance(JobEscrow::SPACE);

    // Create the escrow account with PDA signer
    let bump_ref = &[bump];
    let signer_seeds = seeds!(b"escrow", &args.job_id_hash, ctx.poster.key(), bump_ref);
    let signer = Signer::from(&signer_seeds);

    CreateAccount {
        from: ctx.poster,
        to: ctx.escrow,
        lamports: rent_lamports,
        space: JobEscrow::SPACE as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    // Transfer tokens from poster to escrow token account
    TokenTransfer {
        from: ctx.poster_token_account,
        to: ctx.escrow_token_account,
        authority: ctx.poster,
        amount: args.amount,
    }
    .invoke()?;

    // Initialize escrow data
    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::init(escrow_data)?;

    escrow.job_id_hash = args.job_id_hash;
    escrow.poster = *ctx.poster.key();
    escrow.worker = JobEscrow::DEFAULT_PUBKEY;
    escrow.amount = args.amount;
    escrow.status = EscrowStatus::Active as u8;
    escrow.created_at = clock.unix_timestamp;
    escrow.expires_at = clock.unix_timestamp + expiry;
    escrow.dispute_initiated_at = 0;
    escrow.submitted_at = 0;
    escrow.proof_hash = [0u8; 32];
    escrow.has_proof_hash = 0;
    escrow.dispute_case = JobEscrow::DEFAULT_PUBKEY;
    escrow.has_dispute_case = 0;
    escrow.bump = bump;
    // Token-specific fields
    escrow.is_token_escrow = 1;
    escrow.token_mint = *ctx.token_mint.key();
    escrow.escrow_token_account = *ctx.escrow_token_account.key();

    Ok(())
}
