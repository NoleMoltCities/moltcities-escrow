//! DisputeCase account state
//!
//! Tracks dispute resolution with multi-arbitrator voting.

use pinocchio::{program_error::ProgramError, pubkey::Pubkey};
use crate::errors::EscrowError;

/// Number of arbitrators per dispute
pub const ARBITRATORS_PER_DISPUTE: usize = 5;

/// Majority needed to win (3 of 5)
pub const ARBITRATION_MAJORITY: u8 = 3;

/// Vote options
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Vote {
    /// No vote cast yet
    None = 0,
    /// Vote for worker to receive funds
    ForWorker = 1,
    /// Vote for poster to receive refund
    ForPoster = 2,
}

impl Vote {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::None),
            1 => Some(Self::ForWorker),
            2 => Some(Self::ForPoster),
            _ => None,
        }
    }
}

/// Dispute resolution outcomes
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum DisputeResolution {
    /// Not yet resolved
    Pending = 0,
    /// Worker wins - gets payment
    WorkerWins = 1,
    /// Poster wins - gets refund
    PosterWins = 2,
    /// Split - both get half
    Split = 3,
}

impl DisputeResolution {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Pending),
            1 => Some(Self::WorkerWins),
            2 => Some(Self::PosterWins),
            3 => Some(Self::Split),
            _ => None,
        }
    }
}

/// Dispute case account
///
/// Seeds: ["dispute", escrow]
#[repr(C)]
pub struct DisputeCase {
    /// The escrow this dispute is for
    pub escrow: Pubkey,
    /// Who raised the dispute (poster or worker)
    pub raised_by: Pubkey,
    /// The 5 selected arbitrators
    pub arbitrators: [Pubkey; ARBITRATORS_PER_DISPUTE],
    /// Votes from each arbitrator (indexed by position)
    pub votes: [u8; ARBITRATORS_PER_DISPUTE],
    /// Unix timestamp deadline for voting
    pub voting_deadline: i64,
    /// Resolution outcome
    pub resolution: u8,
    /// Unix timestamp when dispute was created
    pub created_at: i64,
    /// PDA bump seed
    pub bump: u8,
    /// Padding for alignment
    pub _padding: [u8; 5],
    /// Reason for dispute (variable length, stored as fixed buffer)
    /// First 2 bytes = length, then up to 500 bytes of reason
    pub reason_len: u16,
    pub reason: [u8; 500],
}

impl DisputeCase {
    /// Account discriminator
    pub const DISCRIMINATOR: [u8; 8] = [0x44, 0x69, 0x73, 0x70, 0x43, 0x61, 0x73, 0x65]; // "DispCase"
    
    /// Size of the account data
    pub const LEN: usize = 32 + 32 + (32 * ARBITRATORS_PER_DISPUTE) + ARBITRATORS_PER_DISPUTE + 8 + 1 + 8 + 1 + 5 + 2 + 500;
    
    /// Total size including discriminator
    pub const SPACE: usize = 8 + Self::LEN;
    
    /// Maximum reason length
    pub const MAX_REASON_LEN: usize = 500;

    #[inline(always)]
    pub fn load(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() < Self::SPACE {
            return Err(EscrowError::InvalidAccountData.into());
        }
        if data[..8] != Self::DISCRIMINATOR {
            return Err(EscrowError::AccountNotInitialized.into());
        }
        Ok(unsafe { &*(data[8..].as_ptr() as *const Self) })
    }

    #[inline(always)]
    pub fn load_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::SPACE {
            return Err(EscrowError::InvalidAccountData.into());
        }
        if data[..8] != Self::DISCRIMINATOR {
            return Err(EscrowError::AccountNotInitialized.into());
        }
        Ok(unsafe { &mut *(data[8..].as_mut_ptr() as *mut Self) })
    }

    #[inline(always)]
    pub fn init(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::SPACE {
            return Err(EscrowError::InvalidAccountData.into());
        }
        if data[..8] == Self::DISCRIMINATOR {
            return Err(EscrowError::AccountAlreadyInitialized.into());
        }
        data[..8].copy_from_slice(&Self::DISCRIMINATOR);
        data[8..Self::SPACE].fill(0);
        Ok(unsafe { &mut *(data[8..].as_mut_ptr() as *mut Self) })
    }

    /// Get the vote for a specific arbitrator position
    #[inline(always)]
    pub fn get_vote(&self, position: usize) -> Option<Vote> {
        if position >= ARBITRATORS_PER_DISPUTE {
            return None;
        }
        Vote::from_u8(self.votes[position])
    }

    /// Set vote for a position
    #[inline(always)]
    pub fn set_vote(&mut self, position: usize, vote: Vote) {
        if position < ARBITRATORS_PER_DISPUTE {
            self.votes[position] = vote as u8;
        }
    }

    /// Get resolution as enum
    #[inline(always)]
    pub fn get_resolution(&self) -> Option<DisputeResolution> {
        DisputeResolution::from_u8(self.resolution)
    }

    /// Check if dispute is resolved
    #[inline(always)]
    pub fn is_resolved(&self) -> bool {
        self.resolution != DisputeResolution::Pending as u8
    }

    /// Find arbitrator position in the array
    #[inline(always)]
    pub fn find_arbitrator_position(&self, arbitrator: &Pubkey) -> Option<usize> {
        for i in 0..ARBITRATORS_PER_DISPUTE {
            if &self.arbitrators[i] == arbitrator {
                return Some(i);
            }
        }
        None
    }

    /// Count votes for each side
    pub fn count_votes(&self) -> (u8, u8) {
        let mut for_worker = 0u8;
        let mut for_poster = 0u8;
        for &vote in &self.votes {
            match Vote::from_u8(vote) {
                Some(Vote::ForWorker) => for_worker += 1,
                Some(Vote::ForPoster) => for_poster += 1,
                _ => {}
            }
        }
        (for_worker, for_poster)
    }

    /// Check if majority has been reached
    pub fn has_majority(&self) -> bool {
        let (for_worker, for_poster) = self.count_votes();
        for_worker >= ARBITRATION_MAJORITY || for_poster >= ARBITRATION_MAJORITY
    }

    /// Set reason from a string slice
    pub fn set_reason(&mut self, reason: &str) -> Result<(), ProgramError> {
        let bytes = reason.as_bytes();
        if bytes.len() > Self::MAX_REASON_LEN {
            return Err(EscrowError::ReasonTooLong.into());
        }
        self.reason_len = bytes.len() as u16;
        self.reason[..bytes.len()].copy_from_slice(bytes);
        Ok(())
    }

    /// Get reason as a byte slice
    #[inline(always)]
    pub fn get_reason(&self) -> &[u8] {
        &self.reason[..self.reason_len as usize]
    }
}
