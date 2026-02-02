//! Release instructions
//!
//! Handles releasing funds to worker through various paths:
//! - release_to_worker (platform only)
//! - approve_work (poster approves)
//! - auto_release (review window expired)
//! - release_with_reputation (with reputation updates)

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::{
    errors::EscrowError,
    state::{JobEscrow, EscrowStatus, AgentReputation},
    require, require_some,
    PLATFORM_WALLET,
    ID,
};

use super::submit_work::REVIEW_WINDOW_SECONDS;

/// Transfer lamports between accounts
#[inline(always)]
fn transfer_lamports(
    from: &AccountInfo,
    to: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    *from.try_borrow_mut_lamports()? -= amount;
    *to.try_borrow_mut_lamports()? += amount;
    Ok(())
}

// ============== RELEASE TO WORKER (Platform Only) ==============

/// Release to worker accounts
pub struct ReleaseToWorkerAccounts<'a> {
    pub escrow: &'a AccountInfo,
    pub platform_authority: &'a AccountInfo,
    pub worker: &'a AccountInfo,
    pub platform: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for ReleaseToWorkerAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [escrow, platform_authority, worker, platform, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !platform_authority.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        // Platform authority must be PLATFORM_WALLET
        require!(platform_authority.key() == &PLATFORM_WALLET, EscrowError::NotPlatformAuthority);
        require!(platform.key() == &PLATFORM_WALLET, EscrowError::NotPlatformAuthority);

        Ok(Self {
            escrow,
            platform_authority,
            worker,
            platform,
        })
    }
}

/// Process release_to_worker instruction
pub fn process_release_to_worker(
    accounts: &[AccountInfo],
    _data: &[u8],
    program_id: &Pubkey,
) -> ProgramResult {
    let ctx = ReleaseToWorkerAccounts::try_from(accounts)?;

    // SECURITY FIX C-01: Verify escrow account is owned by this program
    if *ctx.escrow.owner() != ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::load_mut(escrow_data)?;

    // SECURITY FIX C-02: Verify escrow PDA derivation
    let (expected_pda, expected_bump) = find_program_address(
        &[b"escrow", &escrow.job_id_hash, &escrow.poster],
        program_id,
    );
    require!(ctx.escrow.key() == &expected_pda, EscrowError::InvalidPda);
    require!(escrow.bump == expected_bump, EscrowError::InvalidPda);

    require!(escrow.status == EscrowStatus::Active as u8, EscrowError::EscrowNotActive);
    require!(escrow.has_worker(), EscrowError::NoWorkerAssigned);
    require!(ctx.worker.key() == &escrow.worker, EscrowError::WorkerMismatch);

    let amount = escrow.amount;
    // SECURITY FIX H-05: Use checked arithmetic
    let platform_fee = amount.checked_div(100).unwrap_or(0);
    let worker_payment = amount.checked_sub(platform_fee).ok_or(EscrowError::ArithmeticOverflow)?;

    escrow.status = EscrowStatus::Released as u8;

    // Transfer funds
    transfer_lamports(ctx.escrow, ctx.worker, worker_payment)?;
    transfer_lamports(ctx.escrow, ctx.platform, platform_fee)?;

    Ok(())
}

// ============== APPROVE WORK (Poster) ==============

/// Approve work accounts
pub struct ApproveWorkAccounts<'a> {
    pub escrow: &'a AccountInfo,
    pub poster: &'a AccountInfo,
    pub worker: &'a AccountInfo,
    pub platform: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for ApproveWorkAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [escrow, poster, worker, platform, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !poster.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        require!(platform.key() == &PLATFORM_WALLET, EscrowError::NotPlatformAuthority);

        Ok(Self { escrow, poster, worker, platform })
    }
}

/// Process approve_work instruction
pub fn process_approve_work(
    accounts: &[AccountInfo],
    _data: &[u8],
    program_id: &Pubkey,
) -> ProgramResult {
    let ctx = ApproveWorkAccounts::try_from(accounts)?;

    // SECURITY FIX C-01: Verify escrow account is owned by this program
    if *ctx.escrow.owner() != ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::load_mut(escrow_data)?;

    // SECURITY FIX C-02: Verify escrow PDA derivation
    let (expected_pda, expected_bump) = find_program_address(
        &[b"escrow", &escrow.job_id_hash, &escrow.poster],
        program_id,
    );
    require!(ctx.escrow.key() == &expected_pda, EscrowError::InvalidPda);
    require!(escrow.bump == expected_bump, EscrowError::InvalidPda);

    require!(escrow.status == EscrowStatus::PendingReview as u8, EscrowError::NotPendingReview);
    require!(ctx.poster.key() == &escrow.poster, EscrowError::PosterMismatch);
    require!(ctx.worker.key() == &escrow.worker, EscrowError::WorkerMismatch);

    let amount = escrow.amount;
    // SECURITY FIX H-05: Use checked arithmetic
    let platform_fee = amount.checked_div(100).unwrap_or(0);
    let worker_payment = amount.checked_sub(platform_fee).ok_or(EscrowError::ArithmeticOverflow)?;

    escrow.status = EscrowStatus::Released as u8;

    transfer_lamports(ctx.escrow, ctx.worker, worker_payment)?;
    transfer_lamports(ctx.escrow, ctx.platform, platform_fee)?;

    Ok(())
}

// ============== AUTO RELEASE (Anyone after deadline) ==============

/// Auto release accounts
pub struct AutoReleaseAccounts<'a> {
    pub escrow: &'a AccountInfo,
    pub cranker: &'a AccountInfo,
    pub worker: &'a AccountInfo,
    pub platform: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for AutoReleaseAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [escrow, cranker, worker, platform, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !cranker.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        require!(platform.key() == &PLATFORM_WALLET, EscrowError::NotPlatformAuthority);

        Ok(Self { escrow, cranker, worker, platform })
    }
}

/// Process auto_release instruction
pub fn process_auto_release(
    accounts: &[AccountInfo],
    _data: &[u8],
    program_id: &Pubkey,
) -> ProgramResult {
    let ctx = AutoReleaseAccounts::try_from(accounts)?;
    let clock = Clock::get()?;

    // SECURITY FIX C-01: Verify escrow account is owned by this program
    if *ctx.escrow.owner() != ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::load_mut(escrow_data)?;

    // SECURITY FIX C-02: Verify escrow PDA derivation
    let (expected_pda, expected_bump) = find_program_address(
        &[b"escrow", &escrow.job_id_hash, &escrow.poster],
        program_id,
    );
    require!(ctx.escrow.key() == &expected_pda, EscrowError::InvalidPda);
    require!(escrow.bump == expected_bump, EscrowError::InvalidPda);

    require!(escrow.status == EscrowStatus::PendingReview as u8, EscrowError::NotPendingReview);
    require!(ctx.worker.key() == &escrow.worker, EscrowError::WorkerMismatch);

    // Check review window expired
    let submitted_at = require_some!(escrow.get_submitted_at(), EscrowError::NoSubmissionTime);
    require!(
        clock.unix_timestamp >= submitted_at + REVIEW_WINDOW_SECONDS,
        EscrowError::ReviewWindowNotExpired
    );

    let amount = escrow.amount;
    // SECURITY FIX H-05: Use checked arithmetic
    let platform_fee = amount.checked_div(100).unwrap_or(0);
    let worker_payment = amount.checked_sub(platform_fee).ok_or(EscrowError::ArithmeticOverflow)?;

    escrow.status = EscrowStatus::Released as u8;

    transfer_lamports(ctx.escrow, ctx.worker, worker_payment)?;
    transfer_lamports(ctx.escrow, ctx.platform, platform_fee)?;

    Ok(())
}

// ============== RELEASE WITH REPUTATION ==============

/// Release with reputation accounts
pub struct ReleaseWithReputationAccounts<'a> {
    pub escrow: &'a AccountInfo,
    pub platform_authority: &'a AccountInfo,
    pub worker: &'a AccountInfo,
    pub platform: &'a AccountInfo,
    pub worker_reputation: &'a AccountInfo,
    pub poster_reputation: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for ReleaseWithReputationAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [escrow, platform_authority, worker, platform, worker_reputation, poster_reputation, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !platform_authority.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        require!(platform_authority.key() == &PLATFORM_WALLET, EscrowError::NotPlatformAuthority);
        require!(platform.key() == &PLATFORM_WALLET, EscrowError::NotPlatformAuthority);

        Ok(Self {
            escrow,
            platform_authority,
            worker,
            platform,
            worker_reputation,
            poster_reputation,
        })
    }
}

/// Process release_with_reputation instruction
pub fn process_release_with_reputation(
    accounts: &[AccountInfo],
    _data: &[u8],
    program_id: &Pubkey,
) -> ProgramResult {
    let ctx = ReleaseWithReputationAccounts::try_from(accounts)?;

    // SECURITY FIX C-01: Verify escrow account is owned by this program
    if *ctx.escrow.owner() != ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // SECURITY FIX C-01: Verify reputation accounts are owned by this program
    if *ctx.worker_reputation.owner() != ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if *ctx.poster_reputation.owner() != ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Load escrow
    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::load_mut(escrow_data)?;

    // SECURITY FIX C-02: Verify escrow PDA derivation
    let (expected_pda, expected_bump) = find_program_address(
        &[b"escrow", &escrow.job_id_hash, &escrow.poster],
        program_id,
    );
    require!(ctx.escrow.key() == &expected_pda, EscrowError::InvalidPda);
    require!(escrow.bump == expected_bump, EscrowError::InvalidPda);

    require!(
        escrow.status == EscrowStatus::Active as u8 || escrow.status == EscrowStatus::PendingReview as u8,
        EscrowError::EscrowNotActive
    );
    require!(escrow.has_worker(), EscrowError::NoWorkerAssigned);
    require!(ctx.worker.key() == &escrow.worker, EscrowError::WorkerMismatch);

    // SECURITY FIX C-03: Verify worker reputation PDA derivation
    let (expected_worker_rep, _) = find_program_address(
        &[b"reputation", &escrow.worker],
        program_id,
    );
    require!(ctx.worker_reputation.key() == &expected_worker_rep, EscrowError::InvalidPda);

    // SECURITY FIX C-03: Verify poster reputation PDA derivation
    let (expected_poster_rep, _) = find_program_address(
        &[b"reputation", &escrow.poster],
        program_id,
    );
    require!(ctx.poster_reputation.key() == &expected_poster_rep, EscrowError::InvalidPda);

    let amount = escrow.amount;
    // SECURITY FIX H-05: Use checked arithmetic
    let platform_fee = amount.checked_div(100).unwrap_or(0);
    let worker_payment = amount.checked_sub(platform_fee).ok_or(EscrowError::ArithmeticOverflow)?;

    escrow.status = EscrowStatus::Released as u8;

    // Update worker reputation
    {
        let worker_rep_data = &mut ctx.worker_reputation.try_borrow_mut_data()?;
        let worker_rep = AgentReputation::load_mut(worker_rep_data)?;
        // SECURITY FIX H-05: Use checked arithmetic
        worker_rep.jobs_completed = worker_rep.jobs_completed.saturating_add(1);
        worker_rep.total_earned = worker_rep.total_earned.saturating_add(worker_payment);
        worker_rep.update_score();
    }

    // Update poster reputation
    {
        let poster_rep_data = &mut ctx.poster_reputation.try_borrow_mut_data()?;
        let poster_rep = AgentReputation::load_mut(poster_rep_data)?;
        // SECURITY FIX H-05: Use checked arithmetic
        poster_rep.jobs_posted = poster_rep.jobs_posted.saturating_add(1);
        poster_rep.total_spent = poster_rep.total_spent.saturating_add(amount);
        poster_rep.update_score();
    }

    // Transfer funds
    transfer_lamports(ctx.escrow, ctx.worker, worker_payment)?;
    transfer_lamports(ctx.escrow, ctx.platform, platform_fee)?;

    Ok(())
}
