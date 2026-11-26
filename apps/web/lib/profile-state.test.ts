import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProfileState } from './profile-state.ts';
import type { Profile } from './profiles.ts';

test('getProfileState returns archived for an archived chain profile', () => {
  const archivedProfile: Profile = {
    name: 'test-handle',
    wallet: '',
    bio: '',
    joined: '',
    source: 'chain',
    archived: true,
  };
  assert.equal(getProfileState(archivedProfile), 'archived');
});

test('getProfileState returns no-wallet for a DB profile without a wallet', () => {
  const dbProfile: Profile = {
    name: 'test-handle',
    wallet: '',
    bio: '',
    joined: '2026-01-01',
    source: 'database',
  };
  assert.equal(getProfileState(dbProfile), 'no-wallet');
});

test('getProfileState returns live for a live chain profile with a wallet', () => {
  const liveChainProfile: Profile = {
    name: 'test-handle',
    wallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    bio: '',
    joined: '',
    source: 'chain',
  };
  assert.equal(getProfileState(liveChainProfile), 'live');
});

test('getProfileState returns live for a DB profile with a wallet', () => {
  const liveDbProfile: Profile = {
    name: 'Test Handle',
    wallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    bio: 'A test bio',
    joined: '2026-01-01',
    source: 'database',
  };
  assert.equal(getProfileState(liveDbProfile), 'live');
});

test('getProfileState returns no-wallet for a null profile', () => {
  assert.equal(getProfileState(null), 'no-wallet');
});

test('getProfileState returns live for a chain profile with archived: false', () => {
  const chainProfile: Profile = {
    name: 'test-handle',
    wallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    bio: '',
    joined: '',
    source: 'chain',
    archived: false,
  };
  assert.equal(getProfileState(chainProfile), 'live');
});
