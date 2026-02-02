//! Arbitrator-related account states
//!
//! Includes ArbitratorPool, ArbitratorEntry, and AccuracyClaim.

use pinocchio::{program_error::ProgramError, pubkey::Pubkey};
use core::mem::size_of;
use crate::errors::EscrowError;

/// Maximum number of arbitrators in the pool
pub const MAX_ARBITRATORS: usize = 100;

/// Minimum stake required to become an arbitrator (0.1 SOL)
pub const MIN_ARBITRATOR_STAKE: u64 = 100_000_000;

/// Fee per vote for arbitrators (0.001 SOL)  
pub const ARBITRATOR_VOTE_FEE: u64 = 1_000_000;

/// Global arbitrator pool
///
/// Seeds: ["arbitrator_pool_v2"]
#[repr(C)]
pub struct ArbitratorPool {
    /// Platform authority who can manage the pool
    pub authority: Pubkey,
    /// Minimum stake required (stored for potential updates)
    pub min_stake: u64,
    /// Number of active arbitrators
    pub arbitrator_count: u32,
    /// PDA bump seed
    pub bump: u8,
    /// Padding for alignment
    pub _padding: [u8; 3],
    /// Array of arbitrator pubkeys (fixed size)
    pub arbitrators: [Pubkey; MAX_ARBITRATORS],
}

impl ArbitratorPool {
    /// Account discriminator
    pub const DISCRIMINATOR: [u8; 8] = [0x41, 0x72, 0x62, 0x50, 0x6f, 0x6f, 0x6c, 0x5f]; // "ArbPool_"
    
    /// Size of the account data (without discriminator)
    pub const LEN: usize = 32 + 8 + 4 + 1 + 3 + (32 * MAX_ARBITRATORS);
    
    /// Total size including 8-byte discriminator
    pub const SPACE: usize = 8 + Self::LEN;
    
    /// Default Pubkey for empty slots
    pub const DEFAULT_PUBKEY: Pubkey = [0u8; 32];

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

    /// Check if an arbitrator is in the pool
    #[inline(always)]
    pub fn contains(&self, pubkey: &Pubkey) -> bool {
        for i in 0..self.arbitrator_count as usize {
            if &self.arbitrators[i] == pubkey {
                return true;
            }
        }
        false
    }

    /// Find index of an arbitrator
    #[inline(always)]
    pub fn find_index(&self, pubkey: &Pubkey) -> Option<usize> {
        for i in 0..self.arbitrator_count as usize {
            if &self.arbitrators[i] == pubkey {
                return Some(i);
            }
        }
        None
    }

    /// Add an arbitrator to the pool
    pub fn add(&mut self, pubkey: Pubkey) -> Result<(), ProgramError> {
        if self.arbitrator_count as usize >= MAX_ARBITRATORS {
            return Err(EscrowError::ArbitratorPoolFull.into());
        }
        if self.contains(&pubkey) {
            return Err(EscrowError::AlreadyArbitrator.into());
        }
        self.arbitrators[self.arbitrator_count as usize] = pubkey;
        self.arbitrator_count += 1;
        Ok(())
    }

    /// Remove an arbitrator from the pool
    pub fn remove(&mut self, pubkey: &Pubkey) -> Result<(), ProgramError> {
        if let Some(idx) = self.find_index(pubkey) {
            // Move last element to this position (swap remove)
            let last_idx = self.arbitrator_count as usize - 1;
            if idx != last_idx {
                self.arbitrators[idx] = self.arbitrators[last_idx];
            }
            self.arbitrators[last_idx] = Self::DEFAULT_PUBKEY;
            self.arbitrator_count -= 1;
            Ok(())
        } else {
            Err(EscrowError::NotSelectedArbitrator.into())
        }
    }
}

/// Individual arbitrator entry
///
/// Seeds: ["arbitrator", agent]
#[repr(C)]
pub struct ArbitratorEntry {
    /// The agent/wallet this entry belongs to
    pub agent: Pubkey,
    /// Staked amount in lamports
    pub stake: u64,
    /// Total cases voted on
    pub cases_voted: u64,
    /// Cases where vote matched resolution
    pub cases_correct: u64,
    /// Whether this arbitrator is active
    pub is_active: u8,
    /// Unix timestamp when registered
    pub registered_at: i64,
    /// PDA bump seed
    pub bump: u8,
    /// Padding for alignment
    pub _padding: [u8; 6],
}

impl ArbitratorEntry {
    /// Account discriminator
    pub const DISCRIMINATOR: [u8; 8] = [0x41, 0x72, 0x62, 0x45, 0x6e, 0x74, 0x72, 0x79]; // "ArbEntry"
    
    /// Size of the account data
    pub const LEN: usize = size_of::<Self>();
    
    /// Total size including discriminator
    pub const SPACE: usize = 8 + Self::LEN;

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

    /// Check if arbitrator is active
    #[inline(always)]
    pub fn is_active(&self) -> bool {
        self.is_active != 0
    }
}

/// Tracks accuracy claims to prevent duplicate calls
///
/// Seeds: ["accuracy_claim", dispute_case, arbitrator]
#[repr(C)]
pub struct AccuracyClaim {
    /// The dispute case this claim is for
    pub dispute_case: Pubkey,
    /// The arbitrator who claimed
    pub arbitrator: Pubkey,
    /// Unix timestamp when claimed
    pub claimed_at: i64,
    /// PDA bump seed
    pub bump: u8,
    /// Padding for alignment
    pub _padding: [u8; 7],
}

impl AccuracyClaim {
    /// Account discriminator
    pub const DISCRIMINATOR: [u8; 8] = [0x41, 0x63, 0x63, 0x43, 0x6c, 0x61, 0x69, 0x6d]; // "AccClaim"
    
    /// Size of the account data
    pub const LEN: usize = size_of::<Self>();
    
    /// Total size including discriminator
    pub const SPACE: usize = 8 + Self::LEN;

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
}
