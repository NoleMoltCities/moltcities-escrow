//! Close instructions
//!
//! Handles closing escrow, dispute case, and arbitrator accounts to reclaim rent.

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    ProgramResult,
};

use crate::{
    errors::EscrowError,
    state::{JobEscrow, EscrowStatus, DisputeCase, ArbitratorPool, ArbitratorEntry},
    require,
    ID,
};

/// Transfer all lamports and close account
#[inline(always)]
fn close_account(account: &AccountInfo, recipient: &AccountInfo) -> ProgramResult {
    let lamports = *account.try_borrow_lamports()?;
    *account.try_borrow_mut_lamports()? = 0;
    *recipient.try_borrow_mut_lamports()? += lamports;
    
    // Zero out data to mark as closed
    let mut data = account.try_borrow_mut_data()?;
    data.fill(0);
    
    Ok(())
}

// ============== CLOSE ESCROW ==============

pub struct CloseEscrowAccounts<'a> {
    pub escrow: &'a AccountInfo,
    pub poster: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for CloseEscrowAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [escrow, poster, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !poster.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self { escrow, poster })
    }
}

/// Process close_escrow instruction
pub fn process_close_escrow(
    accounts: &[AccountInfo],
    _data: &[u8],
    program_id: &Pubkey,
) -> ProgramResult {
    let ctx = CloseEscrowAccounts::try_from(accounts)?;

    // SECURITY FIX C-01: Verify escrow account is owned by this program
    if *ctx.escrow.owner() != ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Load escrow
    let escrow_data = ctx.escrow.try_borrow_data()?;
    let escrow = JobEscrow::load(&escrow_data)?;

    // SECURITY FIX C-02: Verify escrow PDA derivation
    let (expected_pda, expected_bump) = find_program_address(
        &[b"escrow", &escrow.job_id_hash, &escrow.poster],
        program_id,
    );
    require!(ctx.escrow.key() == &expected_pda, EscrowError::InvalidPda);
    require!(escrow.bump == expected_bump, EscrowError::InvalidPda);

    // Can only close if in terminal state
    require!(
        escrow.status == EscrowStatus::Released as u8 ||
        escrow.status == EscrowStatus::Refunded as u8 ||
        escrow.status == EscrowStatus::Expired as u8 ||
        escrow.status == EscrowStatus::Cancelled as u8,
        EscrowError::CannotClose
    );

    // Must be poster
    require!(ctx.poster.key() == &escrow.poster, EscrowError::PosterMismatch);

    // Drop borrow before closing
    drop(escrow_data);

    // Close account and return rent
    close_account(ctx.escrow, ctx.poster)?;

    Ok(())
}

// ============== CLOSE DISPUTE CASE ==============

pub struct CloseDisputeCaseAccounts<'a> {
    pub dispute_case: &'a AccountInfo,
    pub escrow: &'a AccountInfo,
    pub initiator: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for CloseDisputeCaseAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [dispute_case, escrow, initiator, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !initiator.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self { dispute_case, escrow, initiator })
    }
}

/// Process close_dispute_case instruction
pub fn process_close_dispute_case(
    accounts: &[AccountInfo],
    _data: &[u8],
    program_id: &Pubkey,
) -> ProgramResult {
    let ctx = CloseDisputeCaseAccounts::try_from(accounts)?;

    // SECURITY FIX C-01: Verify dispute_case account is owned by this program
    if *ctx.dispute_case.owner() != ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // SECURITY FIX C-01: Verify escrow account is owned by this program
    if *ctx.escrow.owner() != ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Load dispute case
    let dispute_data = ctx.dispute_case.try_borrow_data()?;
    let dispute = DisputeCase::load(&dispute_data)?;

    // SECURITY FIX C-02: Verify dispute_case PDA derivation
    let (expected_dispute_pda, expected_dispute_bump) = find_program_address(
        &[b"dispute", ctx.escrow.key()],
        program_id,
    );
    require!(ctx.dispute_case.key() == &expected_dispute_pda, EscrowError::InvalidPda);
    require!(dispute.bump == expected_dispute_bump, EscrowError::InvalidPda);

    // Must be resolved
    require!(dispute.is_resolved(), EscrowError::DisputeNotResolved);

    // Must be initiator
    require!(ctx.initiator.key() == &dispute.raised_by, EscrowError::Unauthorized);

    // Verify escrow is in terminal state
    let escrow_data = ctx.escrow.try_borrow_data()?;
    let escrow = JobEscrow::load(&escrow_data)?;

    // SECURITY FIX C-02: Verify escrow PDA derivation
    let (expected_escrow_pda, expected_escrow_bump) = find_program_address(
        &[b"escrow", &escrow.job_id_hash, &escrow.poster],
        program_id,
    );
    require!(ctx.escrow.key() == &expected_escrow_pda, EscrowError::InvalidPda);
    require!(escrow.bump == expected_escrow_bump, EscrowError::InvalidPda);

    require!(
        escrow.status == EscrowStatus::Released as u8 ||
        escrow.status == EscrowStatus::Refunded as u8,
        EscrowError::DisputeNotExecuted
    );

    // Drop borrows
    drop(dispute_data);
    drop(escrow_data);

    // Close account
    close_account(ctx.dispute_case, ctx.initiator)?;

    Ok(())
}

// ============== CLOSE ARBITRATOR ACCOUNT ==============

pub struct CloseArbitratorAccountAccounts<'a> {
    pub pool: &'a AccountInfo,
    pub arbitrator_account: &'a AccountInfo,
    pub agent: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for CloseArbitratorAccountAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [pool, arbitrator_account, agent, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !agent.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self { pool, arbitrator_account, agent })
    }
}

/// Process close_arbitrator_account instruction
pub fn process_close_arbitrator_account(
    accounts: &[AccountInfo],
    _data: &[u8],
    program_id: &Pubkey,
) -> ProgramResult {
    let ctx = CloseArbitratorAccountAccounts::try_from(accounts)?;

    // SECURITY FIX C-01: Verify pool account is owned by this program
    if *ctx.pool.owner() != ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // SECURITY FIX C-01: Verify arbitrator_account is owned by this program
    if *ctx.arbitrator_account.owner() != ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // SECURITY FIX H-03: Verify pool PDA derivation
    let (expected_pool_pda, _) = find_program_address(&[b"arbitrator_pool_v2"], program_id);
    require!(ctx.pool.key() == &expected_pool_pda, EscrowError::InvalidPda);

    // SECURITY FIX C-02: Verify arbitrator_account PDA derivation
    let (expected_arb_pda, expected_arb_bump) = find_program_address(
        &[b"arbitrator", ctx.agent.key()],
        program_id,
    );
    require!(ctx.arbitrator_account.key() == &expected_arb_pda, EscrowError::InvalidPda);

    // Load arbitrator
    let arb_data = ctx.arbitrator_account.try_borrow_data()?;
    let arb = ArbitratorEntry::load(&arb_data)?;

    require!(arb.bump == expected_arb_bump, EscrowError::InvalidPda);

    // Must not be active
    require!(!arb.is_active(), EscrowError::ArbitratorStillActive);

    // Must be the agent
    require!(ctx.agent.key() == &arb.agent, EscrowError::Unauthorized);

    // Verify not in pool
    let pool_data = ctx.pool.try_borrow_data()?;
    let pool = ArbitratorPool::load(&pool_data)?;
    require!(!pool.contains(ctx.agent.key()), EscrowError::ArbitratorStillInPool);

    // Drop borrows
    drop(arb_data);
    drop(pool_data);

    // Close account
    close_account(ctx.arbitrator_account, ctx.agent)?;

    Ok(())
}
