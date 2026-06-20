#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token, Address, Bytes, BytesN, Env,
};

const FIRE: u32 = 0;
const WATER: u32 = 1;
const GRASS: u32 = 2;

/// Spin up a test environment with a stake token and a deployed MonsterDuel.
fn setup<'a>() -> (
    Env,
    MonsterDuelClient<'a>,
    token::StellarAssetClient<'a>,
    token::Client<'a>,
    Address, // admin
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    // Create a test "XLM-like" token (Stellar Asset Contract).
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_client = token::Client::new(&env, &sac.address());
    let token_admin = token::StellarAssetClient::new(&env, &sac.address());

    let contract_id = env.register(MonsterDuel, ());
    let client = MonsterDuelClient::new(&env, &contract_id);

    // 2% house fee.
    client.initialize(&sac.address(), &admin, &200);

    (env, client, token_admin, token_client, admin)
}

/// Replicates the on-chain commitment: sha256(monster_be_bytes || secret).
fn make_commit(env: &Env, monster: u32, secret: &BytesN<32>) -> BytesN<32> {
    let mut data = Bytes::new(env);
    data.extend_from_array(&monster.to_be_bytes());
    data.extend_from_array(&secret.to_array());
    env.crypto().sha256(&data).into()
}

fn secret(env: &Env, fill: u8) -> BytesN<32> {
    BytesN::from_array(env, &[fill; 32])
}

#[test]
fn full_duel_type_advantage_decides_winner() {
    let (env, client, token_admin, token, admin) = setup();

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let stake = 100i128;
    token_admin.mint(&p1, &stake);
    token_admin.mint(&p2, &stake);

    // P1 picks FIRE, P2 picks GRASS. FIRE beats GRASS -> P1 must win
    // regardless of luck variance (the +30 bonus exceeds the 0..19 swing).
    let s1 = secret(&env, 0xAA);
    let s2 = secret(&env, 0xBB);
    let commit1 = make_commit(&env, FIRE, &s1);
    let commit2 = make_commit(&env, GRASS, &s2);

    let id = client.create_match(&p1, &stake, &commit1);
    client.join_match(&id, &p2, &commit2);

    client.reveal(&id, &p1, &FIRE, &s1);
    client.reveal(&id, &p2, &GRASS, &s2); // triggers auto-resolve

    let m = client.get_match(&id);
    assert_eq!(m.status, Status::Resolved);
    assert_eq!(m.winner, Some(p1.clone()));

    // Pot = 200, fee = 2% = 4 -> winner gets 196, admin gets 4, loser 0.
    assert_eq!(token.balance(&p1), 196);
    assert_eq!(token.balance(&p2), 0);
    assert_eq!(token.balance(&admin), 4);
}

#[test]
fn opponent_never_joins_creator_refunded() {
    let (env, client, token_admin, token, _admin) = setup();

    let p1 = Address::generate(&env);
    let stake = 100i128;
    token_admin.mint(&p1, &stake);

    let commit1 = make_commit(&env, WATER, &secret(&env, 0x01));
    let id = client.create_match(&p1, &stake, &commit1);
    assert_eq!(token.balance(&p1), 0); // staked into escrow

    // Fast-forward past the join deadline, then reclaim.
    env.ledger().set_timestamp(env.ledger().timestamp() + 3_601);
    client.claim_timeout(&id);

    assert_eq!(token.balance(&p1), 100); // fully refunded
    assert_eq!(client.get_match(&id).status, Status::Refunded);
}

#[test]
fn opponent_ghosts_after_committing_revealer_wins() {
    let (env, client, token_admin, token, admin) = setup();

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let stake = 100i128;
    token_admin.mint(&p1, &stake);
    token_admin.mint(&p2, &stake);

    let s1 = secret(&env, 0x11);
    let commit1 = make_commit(&env, FIRE, &s1);
    let commit2 = make_commit(&env, WATER, &secret(&env, 0x22));

    let id = client.create_match(&p1, &stake, &commit1);
    client.join_match(&id, &p2, &commit2);

    // Only P1 reveals; P2 stalls.
    client.reveal(&id, &p1, &FIRE, &s1);

    env.ledger().set_timestamp(env.ledger().timestamp() + 3_601);
    client.claim_timeout(&id);

    let m = client.get_match(&id);
    assert_eq!(m.status, Status::Resolved);
    assert_eq!(m.winner, Some(p1.clone()));
    // Pot 200 - 2% fee = 196 to the honest player.
    assert_eq!(token.balance(&p1), 196);
    assert_eq!(token.balance(&admin), 4);
}

#[test]
fn wrong_secret_is_rejected() {
    let (env, client, token_admin, _token, _admin) = setup();

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let stake = 100i128;
    token_admin.mint(&p1, &stake);
    token_admin.mint(&p2, &stake);

    let s1 = secret(&env, 0x11);
    let commit1 = make_commit(&env, FIRE, &s1);
    let commit2 = make_commit(&env, WATER, &secret(&env, 0x22));

    let id = client.create_match(&p1, &stake, &commit1);
    client.join_match(&id, &p2, &commit2);

    // P1 tries to reveal a DIFFERENT monster than they committed to.
    let res = client.try_reveal(&id, &p1, &WATER, &s1);
    assert_eq!(res, Err(Ok(Error::CommitMismatch)));
}

#[test]
fn cannot_play_yourself() {
    let (env, client, token_admin, _token, _admin) = setup();

    let p1 = Address::generate(&env);
    token_admin.mint(&p1, &200);

    let commit1 = make_commit(&env, FIRE, &secret(&env, 0x11));
    let commit2 = make_commit(&env, WATER, &secret(&env, 0x22));

    let id = client.create_match(&p1, &100, &commit1);
    let res = client.try_join_match(&id, &p1, &commit2);
    assert_eq!(res, Err(Ok(Error::CannotPlaySelf)));
}
