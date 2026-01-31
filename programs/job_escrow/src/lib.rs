use anchor_lang::prelude::*;
use solana_sha256_hasher::hash as sha256_hash;

declare_id!("27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr");

/// Platform wallet for 1% fees - BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893
pub const PLATFORM_WALLET: Pubkey = pubkey!("BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893");

/// Default escrow expiry: 30 days in seconds
pub const DEFAULT_EXPIRY_SECONDS: i64 = 30 * 24 * 60 * 60;

/// Minimum timelock for refunds after dispute: 24 hours
pub const REFUND_TIMELOCK_SECONDS: i64 = 24 * 60 * 60;

#[program]
pub mod job_escrow {
    use super::*;

    /// Create escrow for a job - poster deposits SOL
    /// 
    /// # Arguments
    /// * `job_id` - Unique identifier for the job (max 64 chars)
    /// * `amount` - Amount of SOL in lamports to deposit
    /// * `expiry_seconds` - Optional custom expiry (defaults to 30 days)
    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        job_id: String,
        amount: u64,
        expiry_seconds: Option<i64>,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        require!(job_id.len() <= 64, EscrowError::JobIdTooLong);
        
        let clock = Clock::get()?;
        let expiry = expiry_seconds.unwrap_or(DEFAULT_EXPIRY_SECONDS);
        require!(expiry > 0, EscrowError::InvalidExpiry);

        // Get keys before borrowing mutably
        let poster_key = ctx.accounts.poster.key();
        let escrow_key = ctx.accounts.escrow.key();
        let expires_at = clock.unix_timestamp + expiry;

        // Transfer SOL from poster to escrow PDA first
        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &poster_key,
            &escrow_key,
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.poster.to_account_info(),
                ctx.accounts.escrow.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        // Now borrow mutably to update state
        let escrow = &mut ctx.accounts.escrow;
        escrow.poster = poster_key;
        escrow.worker = Pubkey::default(); // Not assigned yet
        escrow.job_id = job_id.clone();
        escrow.amount = amount;
        escrow.status = EscrowStatus::Active;
        escrow.created_at = clock.unix_timestamp;
        escrow.expires_at = expires_at;
        escrow.dispute_initiated_at = None;
        escrow.bump = ctx.bumps.escrow;

        emit!(EscrowCreated {
            job_id,
            poster: poster_key,
            amount,
            expires_at,
        });

        Ok(())
    }

    /// Assign a worker to the escrow (called by poster or platform)
    pub fn assign_worker(
        ctx: Context<AssignWorker>,
        worker: Pubkey,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Active, EscrowError::EscrowNotActive);
        require!(escrow.worker == Pubkey::default(), EscrowError::WorkerAlreadyAssigned);
        
        escrow.worker = worker;

        emit!(WorkerAssigned {
            job_id: escrow.job_id.clone(),
            worker,
        });

        Ok(())
    }

    /// Release funds to worker - ONLY platform authority can call this
    /// Takes 1% platform fee, sends 99% to worker
    pub fn release_to_worker(ctx: Context<ReleaseToWorker>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Active, EscrowError::EscrowNotActive);
        require!(escrow.worker != Pubkey::default(), EscrowError::NoWorkerAssigned);
        require!(
            escrow.worker == ctx.accounts.worker.key(),
            EscrowError::WorkerMismatch
        );

        let amount = escrow.amount;
        let platform_fee = amount / 100; // 1%
        let worker_payment = amount - platform_fee;

        escrow.status = EscrowStatus::Released;

        // Get escrow rent to leave behind (minimum for account to exist)
        let escrow_info = escrow.to_account_info();
        let rent = Rent::get()?.minimum_balance(escrow_info.data_len());
        
        // Calculate available lamports (total - rent)
        let escrow_lamports = **escrow_info.try_borrow_lamports()?;
        let available = escrow_lamports.saturating_sub(rent);
        
        // Ensure we have enough
        require!(available >= amount, EscrowError::InsufficientFunds);

        // Transfer to worker (99%)
        **escrow.to_account_info().try_borrow_mut_lamports()? -= worker_payment;
        **ctx.accounts.worker.to_account_info().try_borrow_mut_lamports()? += worker_payment;

        // Transfer to platform (1%)
        **escrow.to_account_info().try_borrow_mut_lamports()? -= platform_fee;
        **ctx.accounts.platform.to_account_info().try_borrow_mut_lamports()? += platform_fee;

        emit!(FundsReleased {
            job_id: escrow.job_id.clone(),
            worker: ctx.accounts.worker.key(),
            worker_payment,
            platform_fee,
        });

        Ok(())
    }

    /// Initiate a dispute (by poster or platform) - starts timelock
    pub fn initiate_dispute(ctx: Context<InitiateDispute>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Active, EscrowError::EscrowNotActive);

        escrow.status = EscrowStatus::Disputed;
        escrow.dispute_initiated_at = Some(Clock::get()?.unix_timestamp);

        emit!(DisputeInitiated {
            job_id: escrow.job_id.clone(),
            initiated_by: ctx.accounts.initiator.key(),
        });

        Ok(())
    }

    /// Refund to poster - ONLY platform authority can call, requires timelock passed
    pub fn refund_to_poster(ctx: Context<RefundToPoster>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let clock = Clock::get()?;

        // Must be disputed or cancelled
        require!(
            escrow.status == EscrowStatus::Disputed || escrow.status == EscrowStatus::Cancelled,
            EscrowError::RefundNotAllowed
        );

        // Check timelock has passed (if disputed)
        if escrow.status == EscrowStatus::Disputed {
            let dispute_time = escrow.dispute_initiated_at.ok_or(EscrowError::NoDisputeTime)?;
            require!(
                clock.unix_timestamp >= dispute_time + REFUND_TIMELOCK_SECONDS,
                EscrowError::TimelockNotPassed
            );
        }

        let amount = escrow.amount;
        escrow.status = EscrowStatus::Refunded;

        // Get escrow rent
        let escrow_info = escrow.to_account_info();
        let rent = Rent::get()?.minimum_balance(escrow_info.data_len());
        let escrow_lamports = **escrow_info.try_borrow_lamports()?;
        let available = escrow_lamports.saturating_sub(rent);
        
        require!(available >= amount, EscrowError::InsufficientFunds);

        // Transfer full amount back to poster (no fee on refunds)
        **escrow.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.poster.to_account_info().try_borrow_mut_lamports()? += amount;

        emit!(FundsRefunded {
            job_id: escrow.job_id.clone(),
            poster: ctx.accounts.poster.key(),
            amount,
        });

        Ok(())
    }

    /// Claim expired escrow - poster can reclaim after expiry if unclaimed
    pub fn claim_expired(ctx: Context<ClaimExpired>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let clock = Clock::get()?;

        require!(escrow.status == EscrowStatus::Active, EscrowError::EscrowNotActive);
        require!(clock.unix_timestamp >= escrow.expires_at, EscrowError::NotExpired);

        let amount = escrow.amount;
        escrow.status = EscrowStatus::Expired;

        // Get escrow rent
        let escrow_info = escrow.to_account_info();
        let rent = Rent::get()?.minimum_balance(escrow_info.data_len());
        let escrow_lamports = **escrow_info.try_borrow_lamports()?;
        let available = escrow_lamports.saturating_sub(rent);
        
        require!(available >= amount, EscrowError::InsufficientFunds);

        // Return to poster
        **escrow.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.poster.to_account_info().try_borrow_mut_lamports()? += amount;

        emit!(EscrowExpired {
            job_id: escrow.job_id.clone(),
            poster: ctx.accounts.poster.key(),
            amount,
        });

        Ok(())
    }

    /// Cancel escrow before worker assigned - poster can cancel freely
    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Active, EscrowError::EscrowNotActive);
        require!(escrow.worker == Pubkey::default(), EscrowError::WorkerAlreadyAssigned);

        let amount = escrow.amount;
        escrow.status = EscrowStatus::Cancelled;

        // Get escrow rent
        let escrow_info = escrow.to_account_info();
        let rent = Rent::get()?.minimum_balance(escrow_info.data_len());
        let escrow_lamports = **escrow_info.try_borrow_lamports()?;
        let available = escrow_lamports.saturating_sub(rent);
        
        require!(available >= amount, EscrowError::InsufficientFunds);

        // Return to poster
        **escrow.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.poster.to_account_info().try_borrow_mut_lamports()? += amount;

        emit!(EscrowCancelled {
            job_id: escrow.job_id.clone(),
            poster: ctx.accounts.poster.key(),
            amount,
        });

        Ok(())
    }

    /// Close escrow account and reclaim rent (only after terminal status)
    pub fn close_escrow(ctx: Context<CloseEscrow>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(
            escrow.status == EscrowStatus::Released ||
            escrow.status == EscrowStatus::Refunded ||
            escrow.status == EscrowStatus::Expired ||
            escrow.status == EscrowStatus::Cancelled,
            EscrowError::CannotClose
        );

        emit!(EscrowClosed {
            job_id: escrow.job_id.clone(),
        });

        Ok(())
    }
}

// ============== ACCOUNTS ==============

#[derive(Accounts)]
#[instruction(job_id: String)]
pub struct CreateEscrow<'info> {
    #[account(
        init,
        payer = poster,
        space = 8 + Escrow::INIT_SPACE,
        // Hash job_id to 32 bytes for PDA (UUIDs are 36 bytes, exceeds 32-byte seed limit)
        seeds = [b"escrow", sha256_hash(job_id.as_bytes()).as_ref(), poster.key().as_ref()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub poster: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AssignWorker<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    /// Must be either the poster or platform authority
    #[account(
        constraint = initiator.key() == escrow.poster || initiator.key() == PLATFORM_WALLET 
            @ EscrowError::Unauthorized
    )]
    pub initiator: Signer<'info>,
}

#[derive(Accounts)]
pub struct ReleaseToWorker<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    /// Platform authority MUST sign releases
    #[account(address = PLATFORM_WALLET @ EscrowError::NotPlatformAuthority)]
    pub platform_authority: Signer<'info>,
    /// CHECK: Worker receives payment, verified against escrow.worker
    #[account(mut)]
    pub worker: AccountInfo<'info>,
    /// CHECK: Platform wallet receives 1% fee
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct InitiateDispute<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    /// Must be poster or platform authority
    #[account(
        constraint = initiator.key() == escrow.poster || initiator.key() == PLATFORM_WALLET 
            @ EscrowError::Unauthorized
    )]
    pub initiator: Signer<'info>,
}

#[derive(Accounts)]
pub struct RefundToPoster<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    /// Platform authority MUST sign refunds
    #[account(address = PLATFORM_WALLET @ EscrowError::NotPlatformAuthority)]
    pub platform_authority: Signer<'info>,
    /// CHECK: Poster receives refund, verified against escrow.poster
    #[account(mut, address = escrow.poster @ EscrowError::PosterMismatch)]
    pub poster: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ClaimExpired<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    /// Poster can claim their expired escrow
    #[account(mut, address = escrow.poster @ EscrowError::PosterMismatch)]
    pub poster: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelEscrow<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    /// Only poster can cancel
    #[account(mut, address = escrow.poster @ EscrowError::PosterMismatch)]
    pub poster: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseEscrow<'info> {
    #[account(
        mut,
        close = poster,
        constraint = poster.key() == escrow.poster @ EscrowError::PosterMismatch
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub poster: Signer<'info>,
}

// ============== STATE ==============

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    /// Job poster who deposited funds
    pub poster: Pubkey,
    /// Assigned worker (default if unassigned)
    pub worker: Pubkey,
    /// Unique job identifier
    #[max_len(64)]
    pub job_id: String,
    /// Escrowed amount in lamports
    pub amount: u64,
    /// Current status
    pub status: EscrowStatus,
    /// Creation timestamp
    pub created_at: i64,
    /// Expiry timestamp (poster can reclaim after)
    pub expires_at: i64,
    /// When dispute was initiated (for timelock)
    pub dispute_initiated_at: Option<i64>,
    /// PDA bump seed
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowStatus {
    /// Funds deposited, awaiting job completion
    Active,
    /// Funds released to worker
    Released,
    /// Funds refunded to poster
    Refunded,
    /// Escrow expired, poster reclaimed
    Expired,
    /// Under dispute (starts timelock)
    Disputed,
    /// Cancelled before worker assigned
    Cancelled,
}

// ============== EVENTS ==============

#[event]
pub struct EscrowCreated {
    pub job_id: String,
    pub poster: Pubkey,
    pub amount: u64,
    pub expires_at: i64,
}

#[event]
pub struct WorkerAssigned {
    pub job_id: String,
    pub worker: Pubkey,
}

#[event]
pub struct FundsReleased {
    pub job_id: String,
    pub worker: Pubkey,
    pub worker_payment: u64,
    pub platform_fee: u64,
}

#[event]
pub struct FundsRefunded {
    pub job_id: String,
    pub poster: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EscrowExpired {
    pub job_id: String,
    pub poster: Pubkey,
    pub amount: u64,
}

#[event]
pub struct DisputeInitiated {
    pub job_id: String,
    pub initiated_by: Pubkey,
}

#[event]
pub struct EscrowCancelled {
    pub job_id: String,
    pub poster: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EscrowClosed {
    pub job_id: String,
}

// ============== ERRORS ==============

#[error_code]
pub enum EscrowError {
    #[msg("Amount must be greater than 0")]
    InvalidAmount,
    #[msg("Job ID too long (max 64 chars)")]
    JobIdTooLong,
    #[msg("Invalid expiry duration")]
    InvalidExpiry,
    #[msg("Escrow is not active")]
    EscrowNotActive,
    #[msg("Worker already assigned to this escrow")]
    WorkerAlreadyAssigned,
    #[msg("No worker assigned to this escrow")]
    NoWorkerAssigned,
    #[msg("Worker address does not match escrow")]
    WorkerMismatch,
    #[msg("Poster address does not match escrow")]
    PosterMismatch,
    #[msg("Only platform authority can perform this action")]
    NotPlatformAuthority,
    #[msg("Unauthorized to perform this action")]
    Unauthorized,
    #[msg("Refund not allowed in current state")]
    RefundNotAllowed,
    #[msg("Dispute timelock has not passed (24h required)")]
    TimelockNotPassed,
    #[msg("No dispute timestamp recorded")]
    NoDisputeTime,
    #[msg("Escrow has not expired yet")]
    NotExpired,
    #[msg("Cannot close escrow in current state")]
    CannotClose,
    #[msg("Insufficient funds in escrow")]
    InsufficientFunds,
}
