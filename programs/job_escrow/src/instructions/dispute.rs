//! Dispute instructions
//!
//! Handles dispute initiation, refunds, and expired claims.

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::{
    errors::EscrowError,
    state::{JobEscrow, EscrowStatus},
    require, require_some,
    PLATFORM_WALLET,
};

/// Minimum timelock for refunds after dispute: 24 hours
pub const REFUND_TIMELOCK_SECONDS: i64 = 24 * 60 * 60;

/// Grace period after arbitration expiry before emergency release (48 hours)
pub const ARBITRATION_GRACE_PERIOD: i64 = 48 * 60 * 60;

/// Transfer lamports
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

// ============== INITIATE DISPUTE ==============

/// Initiate dispute accounts
pub struct InitiateDisputeAccounts<'a> {
    pub escrow: &'a AccountInfo,
    pub initiator: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for InitiateDisputeAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [escrow, initiator, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !initiator.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self { escrow, initiator })
    }
}

/// Process initiate_dispute instruction
pub fn process_initiate_dispute(
    accounts: &[AccountInfo],
    _data: &[u8],
    _program_id: &Pubkey,
) -> ProgramResult {
    let ctx = InitiateDisputeAccounts::try_from(accounts)?;
    let clock = Clock::get()?;

    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::load_mut(escrow_data)?;

    // Must be Active or PendingReview
    require!(
        escrow.status == EscrowStatus::Active as u8 || escrow.status == EscrowStatus::PendingReview as u8,
        EscrowError::EscrowNotActive
    );

    // Initiator must be poster or platform
    let initiator_key = ctx.initiator.key();
    let is_poster = initiator_key == &escrow.poster;
    let is_platform = initiator_key == &PLATFORM_WALLET;
    require!(is_poster || is_platform, EscrowError::Unauthorized);

    escrow.status = EscrowStatus::Disputed as u8;
    escrow.dispute_initiated_at = clock.unix_timestamp;

    Ok(())
}

// ============== REFUND TO POSTER ==============

/// Refund to poster accounts
pub struct RefundToPosterAccounts<'a> {
    pub escrow: &'a AccountInfo,
    pub platform_authority: &'a AccountInfo,
    pub poster: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for RefundToPosterAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [escrow, platform_authority, poster, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !platform_authority.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        require!(platform_authority.key() == &PLATFORM_WALLET, EscrowError::NotPlatformAuthority);

        Ok(Self { escrow, platform_authority, poster })
    }
}

/// Process refund_to_poster instruction
pub fn process_refund_to_poster(
    accounts: &[AccountInfo],
    _data: &[u8],
    _program_id: &Pubkey,
) -> ProgramResult {
    let ctx = RefundToPosterAccounts::try_from(accounts)?;
    let clock = Clock::get()?;

    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::load_mut(escrow_data)?;

    // Must be Disputed or Cancelled
    require!(
        escrow.status == EscrowStatus::Disputed as u8 || escrow.status == EscrowStatus::Cancelled as u8,
        EscrowError::RefundNotAllowed
    );

    // Verify poster
    require!(ctx.poster.key() == &escrow.poster, EscrowError::PosterMismatch);

    // If disputed, check timelock
    if escrow.status == EscrowStatus::Disputed as u8 {
        let dispute_time = require_some!(escrow.get_dispute_initiated_at(), EscrowError::NoDisputeTime);
        require!(
            clock.unix_timestamp >= dispute_time + REFUND_TIMELOCK_SECONDS,
            EscrowError::TimelockNotPassed
        );
    }

    let amount = escrow.amount;
    escrow.status = EscrowStatus::Refunded as u8;

    transfer_lamports(ctx.escrow, ctx.poster, amount)?;

    Ok(())
}

// ============== CLAIM EXPIRED ==============

/// Claim expired accounts
pub struct ClaimExpiredAccounts<'a> {
    pub escrow: &'a AccountInfo,
    pub poster: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for ClaimExpiredAccounts<'a> {
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

/// Process claim_expired instruction
pub fn process_claim_expired(
    accounts: &[AccountInfo],
    _data: &[u8],
    _program_id: &Pubkey,
) -> ProgramResult {
    let ctx = ClaimExpiredAccounts::try_from(accounts)?;
    let clock = Clock::get()?;

    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::load_mut(escrow_data)?;

    require!(escrow.status == EscrowStatus::Active as u8, EscrowError::EscrowNotActive);
    require!(ctx.poster.key() == &escrow.poster, EscrowError::PosterMismatch);
    require!(clock.unix_timestamp >= escrow.expires_at, EscrowError::NotExpired);

    let amount = escrow.amount;
    escrow.status = EscrowStatus::Expired as u8;

    transfer_lamports(ctx.escrow, ctx.poster, amount)?;

    Ok(())
}

// ============== CANCEL ESCROW ==============

/// Cancel escrow accounts
pub struct CancelEscrowAccounts<'a> {
    pub escrow: &'a AccountInfo,
    pub poster: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for CancelEscrowAccounts<'a> {
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

/// Process cancel_escrow instruction
pub fn process_cancel_escrow(
    accounts: &[AccountInfo],
    _data: &[u8],
    _program_id: &Pubkey,
) -> ProgramResult {
    let ctx = CancelEscrowAccounts::try_from(accounts)?;

    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::load_mut(escrow_data)?;

    require!(escrow.status == EscrowStatus::Active as u8, EscrowError::EscrowNotActive);
    require!(ctx.poster.key() == &escrow.poster, EscrowError::PosterMismatch);
    require!(!escrow.has_worker(), EscrowError::WorkerAlreadyAssigned);

    let amount = escrow.amount;
    escrow.status = EscrowStatus::Cancelled as u8;

    transfer_lamports(ctx.escrow, ctx.poster, amount)?;

    Ok(())
}

// ============== CLAIM EXPIRED ARBITRATION ==============

/// Claim expired arbitration accounts
pub struct ClaimExpiredArbitrationAccounts<'a> {
    pub escrow: &'a AccountInfo,
    pub poster: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for ClaimExpiredArbitrationAccounts<'a> {
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

/// Process claim_expired_arbitration instruction
pub fn process_claim_expired_arbitration(
    accounts: &[AccountInfo],
    _data: &[u8],
    _program_id: &Pubkey,
) -> ProgramResult {
    let ctx = ClaimExpiredArbitrationAccounts::try_from(accounts)?;
    let clock = Clock::get()?;

    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::load_mut(escrow_data)?;

    require!(escrow.status == EscrowStatus::InArbitration as u8, EscrowError::NotInArbitration);
    require!(ctx.poster.key() == &escrow.poster, EscrowError::PosterMismatch);

    // Must be past expiry + grace period
    let emergency_deadline = escrow.expires_at + ARBITRATION_GRACE_PERIOD;
    require!(
        clock.unix_timestamp >= emergency_deadline,
        EscrowError::ArbitrationGracePeriodNotPassed
    );

    let amount = escrow.amount;
    escrow.status = EscrowStatus::Refunded as u8;

    // No fee for emergency release
    transfer_lamports(ctx.escrow, ctx.poster, amount)?;

    Ok(())
}
