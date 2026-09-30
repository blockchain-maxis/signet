/**
 * @file @signet/spec
 *
 * The `@stellar/stellar-sdk` version this package decodes specs with,
 * recorded on every `ContractSpec` and in `InterfaceUnreadable` so a decode
 * failure says which SDK could not read the section.
 *
 * A constant rather than a read of the SDK's package.json: that would need
 * `fs` (not available in the browser) or a JSON import the SDK's `exports`
 * map does not allow. `parse.test.ts` fails when this drifts from the SDK
 * that is actually installed, so bumping the dependency means bumping this.
 */
export const STELLAR_SDK_VERSION = '16.1.0';
