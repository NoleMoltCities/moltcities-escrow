//! Close instructions
//!
//! Handles closing escrow, dispute case, and arbitrator accounts to reclaim rent.

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::{
    errors::EscrowError,
    state::{JobEscrow, EscrowStatus, DisputeCase, ArbitratorPool, ArbitratorEntry},
    require,
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
    _program_id: &Pubkey,
) -> ProgramResult {
    let ctx = CloseEscrowAccounts::try_from(accounts)?;

    // Load escrow
    let escrow_data = ctx.escrow.try_borrow_data()?;
    let escrow = JobEscrow::load(&escrow_data)?;

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
    _program_id: &Pubkey,
) -> ProgramResult {
    let ctx = CloseDisputeCaseAccounts::try_from(accounts)?;

    // Load dispute case
    let dispute_data = ctx.dispute_case.try_borrow_data()?;
    let dispute = DisputeCase::load(&dispute_data)?;

    // Must be resolved
    require!(dispute.is_resolved(), EscrowError::DisputeNotResolved);

    // Must be initiator
    require!(ctx.initiator.key() == &dispute.raised_by, EscrowError::Unauthorized);

    // Verify escrow is in terminal state
    let escrow_data = ctx.escrow.try_borrow_data()?;
    let escrow = JobEscrow::load(&escrow_data)?;

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
    _program_id: &Pubkey,
) -> ProgramResult {
    let ctx = CloseArbitratorAccountAccounts::try_from(accounts)?;

    // Load arbitrator
    let arb_data = ctx.arbitrator_account.try_borrow_data()?;
    let arb = ArbitratorEntry::load(&arb_data)?;

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
