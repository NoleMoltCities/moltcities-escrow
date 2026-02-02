//! Custom error codes for the Job Escrow program
//!
//! Error codes start at 6000 (Anchor convention for custom errors)

use pinocchio::program_error::ProgramError;

/// Custom error codes
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum EscrowError {
    /// Amount must be greater than minimum (0.01 SOL)
    AmountTooLow = 6000,
    /// Job ID too long (max 64 chars)
    JobIdTooLong = 6001,
    /// Invalid expiry duration
    InvalidExpiry = 6002,
    /// Escrow is not active
    EscrowNotActive = 6003,
    /// Worker already assigned to this escrow
    WorkerAlreadyAssigned = 6004,
    /// No worker assigned to this escrow
    NoWorkerAssigned = 6005,
    /// Worker address does not match escrow
    WorkerMismatch = 6006,
    /// Poster address does not match escrow
    PosterMismatch = 6007,
    /// Only platform authority can perform this action
    NotPlatformAuthority = 6008,
    /// Unauthorized to perform this action
    Unauthorized = 6009,
    /// Refund not allowed in current state
    RefundNotAllowed = 6010,
    /// Dispute timelock has not passed (24h required)
    TimelockNotPassed = 6011,
    /// No dispute timestamp recorded
    NoDisputeTime = 6012,
    /// Escrow has not expired yet
    NotExpired = 6013,
    /// Cannot close escrow in current state
    CannotClose = 6014,
    /// Insufficient funds in escrow
    InsufficientFunds = 6015,
    /// Escrow is not in pending review state
    NotPendingReview = 6016,
    /// No submission timestamp recorded
    NoSubmissionTime = 6017,
    /// Review window has not expired yet (24h required)
    ReviewWindowNotExpired = 6018,
    /// Arbitrator pool is full (max 100)
    ArbitratorPoolFull = 6019,
    /// Already registered as arbitrator
    AlreadyArbitrator = 6020,
    /// Arbitrator is not active
    ArbitratorNotActive = 6021,
    /// Not enough arbitrators in pool (need 5)
    NotEnoughArbitrators = 6022,
    /// Reason too long (max 500 chars)
    ReasonTooLong = 6023,
    /// Not selected as arbitrator for this case
    NotSelectedArbitrator = 6024,
    /// Already voted on this dispute
    AlreadyVoted = 6025,
    /// Dispute already resolved
    DisputeAlreadyResolved = 6026,
    /// Voting deadline has passed
    VotingDeadlinePassed = 6027,
    /// Voting not complete (no majority and deadline not passed)
    VotingNotComplete = 6028,
    /// Dispute not yet resolved
    DisputeNotResolved = 6029,
    /// Escrow mismatch
    EscrowMismatch = 6030,
    /// Invalid status for execution
    InvalidStatusForExecution = 6031,
    /// Job ID hash does not match provided job ID
    HashMismatch = 6032,
    /// Arbitrator did not vote on this dispute
    ArbitratorDidNotVote = 6033,
    /// Dispute has not been executed yet
    DisputeNotExecuted = 6034,
    /// Arbitrator is still active - unregister first
    ArbitratorStillActive = 6035,
    /// Arbitrator is still in the pool
    ArbitratorStillInPool = 6036,
    /// Escrow is not in arbitration
    NotInArbitration = 6037,
    /// Arbitration grace period has not passed (48h after expiry)
    ArbitrationGracePeriodNotPassed = 6038,
    /// Invalid account data length
    InvalidAccountData = 6039,
    /// Account not initialized
    AccountNotInitialized = 6040,
    /// Account already initialized
    AccountAlreadyInitialized = 6041,
    /// Invalid PDA
    InvalidPda = 6042,
    /// Arithmetic overflow
    ArithmeticOverflow = 6043,
}

impl From<EscrowError> for ProgramError {
    fn from(e: EscrowError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

/// Helper macro for returning custom errors
#[macro_export]
macro_rules! require {
    ($cond:expr, $err:expr) => {
        if !$cond {
            return Err($err.into());
        }
    };
}

/// Helper macro for Option unwrapping with custom error
#[macro_export]
macro_rules! require_some {
    ($opt:expr, $err:expr) => {
        match $opt {
            Some(v) => v,
            None => return Err($err.into()),
        }
    };
}
