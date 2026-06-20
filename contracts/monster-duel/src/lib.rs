#![no_std]
//! # Monster Duel — a trustless 1v1 staking battle game on Soroban
//!
//! The smart contract is NOT the game engine. It is the **bank + referee**:
//!   * it escrows each player's stake,
//!   * it enforces a fair "commit–reveal" so neither player can copy the other,
//!   * it computes the winner deterministically on-chain, and
//!   * it pays the whole pot to the winner automatically.
//!
//! The flashy battle animation lives in the frontend; this contract only
//! guarantees that the *money* moves according to rules nobody can cheat.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Bytes,
    BytesN, Env,
};

// ----------------------------------------------------------------------------
// Game constants
// ----------------------------------------------------------------------------

/// Monster type ids (rock–paper–scissors style):
///   0 = FIRE  beats GRASS
///   1 = WATER beats FIRE
///   2 = GRASS beats WATER
/// FIRE and WATER are kept for readability/documentation of the scheme even
/// though the win logic is computed arithmetically in `type_bonus`.
#[allow(dead_code)]
const FIRE: u32 = 0;
#[allow(dead_code)]
const WATER: u32 = 1;
/// Highest valid monster id — used to validate reveals.
const GRASS: u32 = 2;

/// Base combat power shared by every monster before bonuses.
const BASE_POWER: u32 = 50;
/// Extra power granted when your type has the elemental advantage.
const TYPE_BONUS: u32 = 30;
/// Maximum random "luck" variance added to each fighter (0..VARIANCE).
const VARIANCE: u32 = 20;

/// Seconds an opponent has to join before the creator can reclaim the stake.
const JOIN_TIMEOUT: u64 = 3_600; // 1 hour
/// Seconds both players have to reveal before a timeout can be claimed.
const REVEAL_TIMEOUT: u64 = 3_600; // 1 hour

/// Persistent-storage time-to-live bumping (in ledgers, ~5s each).
const TTL_THRESHOLD: u32 = 17_280; // ~1 day
const TTL_EXTEND: u32 = 60_480; // ~3.5 days

// ----------------------------------------------------------------------------
// Errors
// ----------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    MatchNotFound = 3,
    InvalidState = 4,
    InvalidStake = 5,
    InvalidMonster = 6,
    NotAPlayer = 7,
    CannotPlaySelf = 8,
    CommitMismatch = 9,
    AlreadyRevealed = 10,
    TooEarly = 11,
    InvalidFee = 12,
}

// ----------------------------------------------------------------------------
// Data model
// ----------------------------------------------------------------------------

/// Lifecycle of a single duel.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    /// Created by player 1, waiting for an opponent to join.
    Waiting = 0,
    /// Both players have joined & committed, waiting for reveals.
    Committed = 1,
    /// Battle resolved, pot paid to the winner.
    Resolved = 2,
    /// Stakes were refunded (timeout with no clear winner).
    Refunded = 3,
}

/// Global configuration set once at deployment.
#[contracttype]
#[derive(Clone)]
pub struct Config {
    /// The token used for stakes (e.g. the native XLM Stellar Asset Contract).
    pub token: Address,
    /// Receives the house fee from each resolved pot.
    pub admin: Address,
    /// House fee in basis points (1% = 100, max 1000 = 10%).
    pub fee_bps: u32,
}

/// A single duel between two players.
#[contracttype]
#[derive(Clone)]
pub struct Match {
    pub id: u32,
    pub player1: Address,
    pub player2: Option<Address>,
    pub stake: i128,
    pub commit1: BytesN<32>,
    pub commit2: Option<BytesN<32>>,
    pub monster1: Option<u32>,
    pub monster2: Option<u32>,
    pub secret1: Option<BytesN<32>>,
    pub secret2: Option<BytesN<32>>,
    pub status: Status,
    /// Unix timestamp after which a timeout can be claimed.
    pub deadline: u64,
    pub winner: Option<Address>,
}

#[contracttype]
pub enum DataKey {
    Config,
    MatchCount,
    Match(u32),
}

// ----------------------------------------------------------------------------
// Contract
// ----------------------------------------------------------------------------

#[contract]
pub struct MonsterDuel;

#[contractimpl]
impl MonsterDuel {
    /// Configure the contract once. `token` is the stake asset (the native XLM
    /// SAC on testnet), `admin` receives fees, `fee_bps` is the house cut.
    pub fn initialize(env: Env, token: Address, admin: Address, fee_bps: u32) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(Error::AlreadyInitialized);
        }
        if fee_bps > 1_000 {
            return Err(Error::InvalidFee);
        }
        env.storage().instance().set(
            &DataKey::Config,
            &Config {
                token,
                admin,
                fee_bps,
            },
        );
        env.storage().instance().set(&DataKey::MatchCount, &0u32);
        Ok(())
    }

    /// Player 1 opens a duel: stakes `stake` tokens and submits a *commitment*
    /// `commit1 = sha256(monster_id || secret)` so the chosen monster stays
    /// hidden from the opponent. Returns the new match id.
    pub fn create_match(
        env: Env,
        player1: Address,
        stake: i128,
        commit1: BytesN<32>,
    ) -> Result<u32, Error> {
        let config = Self::config(&env)?;
        if stake <= 0 {
            return Err(Error::InvalidStake);
        }
        player1.require_auth();

        // Pull player 1's stake into the contract's escrow balance.
        Self::token(&env, &config).transfer(
            &player1,
            &env.current_contract_address(),
            &stake,
        );

        let id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MatchCount)
            .unwrap_or(0);
        let next = id + 1;
        env.storage().instance().set(&DataKey::MatchCount, &next);

        let m = Match {
            id: next,
            player1: player1.clone(),
            player2: None,
            stake,
            commit1,
            commit2: None,
            monster1: None,
            monster2: None,
            secret1: None,
            secret2: None,
            status: Status::Waiting,
            deadline: env.ledger().timestamp() + JOIN_TIMEOUT,
            winner: None,
        };
        Self::save_match(&env, &m);

        env.events()
            .publish((symbol_short!("created"), next), player1);
        Ok(next)
    }

    /// Player 2 joins an open duel, matching the stake and submitting their own
    /// hidden commitment. After this both stakes sit in escrow.
    pub fn join_match(
        env: Env,
        match_id: u32,
        player2: Address,
        commit2: BytesN<32>,
    ) -> Result<(), Error> {
        let config = Self::config(&env)?;
        let mut m = Self::load_match(&env, match_id)?;

        if m.status != Status::Waiting {
            return Err(Error::InvalidState);
        }
        if m.player1 == player2 {
            return Err(Error::CannotPlaySelf);
        }
        player2.require_auth();

        Self::token(&env, &config).transfer(
            &player2,
            &env.current_contract_address(),
            &m.stake,
        );

        m.player2 = Some(player2.clone());
        m.commit2 = Some(commit2);
        m.status = Status::Committed;
        m.deadline = env.ledger().timestamp() + REVEAL_TIMEOUT;
        Self::save_match(&env, &m);

        env.events()
            .publish((symbol_short!("joined"), match_id), player2);
        Ok(())
    }

    /// Reveal your monster and secret. The contract verifies it matches your
    /// earlier commitment. When BOTH players have revealed, the battle is
    /// resolved automatically and the pot is paid out.
    pub fn reveal(
        env: Env,
        match_id: u32,
        player: Address,
        monster: u32,
        secret: BytesN<32>,
    ) -> Result<(), Error> {
        Self::config(&env)?;
        let mut m = Self::load_match(&env, match_id)?;

        if m.status != Status::Committed {
            return Err(Error::InvalidState);
        }
        if monster > GRASS {
            return Err(Error::InvalidMonster);
        }
        player.require_auth();

        let expected = Self::compute_commit(&env, monster, &secret);

        if player == m.player1 {
            if m.monster1.is_some() {
                return Err(Error::AlreadyRevealed);
            }
            if expected != m.commit1 {
                return Err(Error::CommitMismatch);
            }
            m.monster1 = Some(monster);
            m.secret1 = Some(secret);
        } else if Some(player.clone()) == m.player2 {
            if m.monster2.is_some() {
                return Err(Error::AlreadyRevealed);
            }
            if expected != m.commit2.clone().unwrap() {
                return Err(Error::CommitMismatch);
            }
            m.monster2 = Some(monster);
            m.secret2 = Some(secret);
        } else {
            return Err(Error::NotAPlayer);
        }

        // Both revealed → fight!
        if m.monster1.is_some() && m.monster2.is_some() {
            Self::resolve(&env, &mut m);
        } else {
            Self::save_match(&env, &m);
        }
        Ok(())
    }

    /// Rescue funds when an opponent stalls.
    ///   * Nobody joined  -> refund player 1.
    ///   * One side revealed, the other didn't -> the revealer wins the pot.
    ///   * Neither revealed -> both stakes refunded.
    /// Callable by anyone, but only after the match deadline has passed.
    pub fn claim_timeout(env: Env, match_id: u32) -> Result<(), Error> {
        let config = Self::config(&env)?;
        let mut m = Self::load_match(&env, match_id)?;

        if env.ledger().timestamp() < m.deadline {
            return Err(Error::TooEarly);
        }

        let token = Self::token(&env, &config);
        let contract = env.current_contract_address();

        match m.status {
            Status::Waiting => {
                // No opponent ever joined: give player 1 their stake back.
                token.transfer(&contract, &m.player1, &m.stake);
                m.status = Status::Refunded;
            }
            Status::Committed => {
                let pot = m.stake * 2;
                let p2 = m.player2.clone().unwrap();
                match (m.monster1, m.monster2) {
                    (Some(_), None) => {
                        // Player 1 showed up, player 2 ghosted.
                        Self::pay_winner(&env, &config, &m.player1, pot);
                        m.winner = Some(m.player1.clone());
                        m.status = Status::Resolved;
                    }
                    (None, Some(_)) => {
                        Self::pay_winner(&env, &config, &p2, pot);
                        m.winner = Some(p2);
                        m.status = Status::Resolved;
                    }
                    _ => {
                        // Neither (or — impossible — both) revealed: refund.
                        token.transfer(&contract, &m.player1, &m.stake);
                        token.transfer(&contract, &p2, &m.stake);
                        m.status = Status::Refunded;
                    }
                }
            }
            _ => return Err(Error::InvalidState),
        }

        Self::save_match(&env, &m);
        env.events()
            .publish((symbol_short!("timeout"), match_id), m.status);
        Ok(())
    }

    /// Read a match (used by the frontend to render state).
    pub fn get_match(env: Env, match_id: u32) -> Result<Match, Error> {
        Self::load_match(&env, match_id)
    }

    /// Read the global config.
    pub fn get_config(env: Env) -> Result<Config, Error> {
        Self::config(&env)
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    /// Deterministic battle resolution + payout. Called once both monsters
    /// are revealed. Winner is decided by: base power + elemental type bonus
    /// + a luck value derived from BOTH secrets (so no single player can
    /// predict or rig the outcome alone).
    fn resolve(env: &Env, m: &mut Match) {
        let config = Self::config(env).unwrap();
        let mon1 = m.monster1.unwrap();
        let mon2 = m.monster2.unwrap();
        let s1 = m.secret1.clone().unwrap();
        let s2 = m.secret2.clone().unwrap();

        // Shared randomness seed = sha256(secret1 || secret2 || match_id).
        let mut seed_data = Bytes::new(env);
        seed_data.extend_from_array(&s1.to_array());
        seed_data.extend_from_array(&s2.to_array());
        seed_data.extend_from_array(&m.id.to_be_bytes());
        let seed: BytesN<32> = env.crypto().sha256(&seed_data).into();
        let seed = seed.to_array();

        let var1 = (seed[0] as u32) % VARIANCE;
        let var2 = (seed[1] as u32) % VARIANCE;

        let power1 = BASE_POWER + Self::type_bonus(mon1, mon2) + var1;
        let power2 = BASE_POWER + Self::type_bonus(mon2, mon1) + var2;

        let winner = if power1 > power2 {
            m.player1.clone()
        } else if power2 > power1 {
            m.player2.clone().unwrap()
        } else {
            // Exact tie → break it with one more seed byte.
            if seed[2] % 2 == 0 {
                m.player1.clone()
            } else {
                m.player2.clone().unwrap()
            }
        };

        let pot = m.stake * 2;
        Self::pay_winner(env, &config, &winner, pot);

        m.winner = Some(winner.clone());
        m.status = Status::Resolved;
        Self::save_match(env, m);

        env.events()
            .publish((symbol_short!("resolved"), m.id), winner);
    }

    /// Returns TYPE_BONUS if `attacker` type beats `defender` type, else 0.
    /// FIRE>GRASS, WATER>FIRE, GRASS>WATER  =>  a beats b when (a + 2) % 3 == b.
    fn type_bonus(attacker: u32, defender: u32) -> u32 {
        if (attacker + 2) % 3 == defender {
            TYPE_BONUS
        } else {
            0
        }
    }

    /// Pays `pot` to `winner` minus the house fee (which goes to admin).
    fn pay_winner(env: &Env, config: &Config, winner: &Address, pot: i128) {
        let token = Self::token(env, config);
        let contract = env.current_contract_address();
        let fee = pot * (config.fee_bps as i128) / 10_000;
        let payout = pot - fee;
        if fee > 0 {
            token.transfer(&contract, &config.admin, &fee);
        }
        token.transfer(&contract, winner, &payout);
    }

    /// commit = sha256(monster_id_be_bytes || secret).
    fn compute_commit(env: &Env, monster: u32, secret: &BytesN<32>) -> BytesN<32> {
        let mut data = Bytes::new(env);
        data.extend_from_array(&monster.to_be_bytes());
        data.extend_from_array(&secret.to_array());
        env.crypto().sha256(&data).into()
    }

    fn config(env: &Env) -> Result<Config, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)
    }

    fn token<'a>(env: &Env, config: &Config) -> token::Client<'a> {
        token::Client::new(env, &config.token)
    }

    fn load_match(env: &Env, id: u32) -> Result<Match, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Match(id))
            .ok_or(Error::MatchNotFound)
    }

    fn save_match(env: &Env, m: &Match) {
        let key = DataKey::Match(m.id);
        env.storage().persistent().set(&key, m);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
    }
}

mod test;
