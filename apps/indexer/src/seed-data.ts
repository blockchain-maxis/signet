export interface SeedProfile {
  handle: string;
  displayName: string;
  bio: string;
  wallets: string[];
}

export const seedProfiles: SeedProfile[] = [
  {
    handle: 'aquawolf',
    displayName: 'Aquawolf',
    bio: 'Building counter-MEV settlement infrastructure on Stellar.',
    wallets: [
      // TODO: replace with a real public Soroban deployer wallet pubkey (G...).
      // For initial dev/test use a known testnet wallet you control.
      // Do NOT fabricate or guess addresses — only real, verified Stellar accounts.
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ],
  },
  // Add more profiles here before the demo.
  // Each wallet must be a real, public Stellar account with on-chain history.
];
