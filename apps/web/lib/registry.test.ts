import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Account, xdr } from '@stellar/stellar-sdk';
import {
  buildReleaseTransaction,
  releaseHandle,
  isRegistryConfigured,
  RegistryNotConfiguredError,
} from './registry.ts';

const WALLET = 'GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG';
const CONTRACT_ID = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';

afterEach(() => {
  delete process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID;
});

test('buildReleaseTransaction builds one invokeHostFunction calling release with handle ScString', async () => {
  const account = new Account(WALLET, '100');
  const handle = 'alice';

  const tx = await buildReleaseTransaction(account, handle, {
    contractId: CONTRACT_ID,
    networkPassphrase: 'Test SDF Network ; September 2015',
  });

  // Verify on the built Transaction object: exactly one operation of type invokeHostFunction
  assert.equal(tx.operations.length, 1);
  const op = tx.operations[0];
  assert.equal(op.type, 'invokeHostFunction');

  const invokeArgs = op.func.invokeContract();
  assert.equal(invokeArgs.functionName().toString(), 'release');
  assert.equal(invokeArgs.args().length, 1);
  const arg = invokeArgs.args()[0];
  assert.equal(arg.switch().name, 'scvString');
  assert.equal(arg.str().toString(), 'alice');

  // Verify on the decoded XDR envelope
  const env = xdr.TransactionEnvelope.fromXDR(tx.toXDR(), 'base64');
  const opBody = env.v1().tx().operations()[0];
  assert.ok(opBody);
  const txOp = opBody.body();
  assert.equal(txOp.switch().name, 'invokeHostFunction');

  const hostFn = txOp.invokeHostFunctionOp().hostFunction();
  assert.equal(hostFn.switch().name, 'hostFunctionTypeInvokeContract');

  const xdrInvoke = hostFn.invokeContract();
  assert.equal(xdrInvoke.functionName().toString(), 'release');
  assert.equal(xdrInvoke.args().length, 1);

  const xdrArg = xdrInvoke.args()[0];
  assert.ok(xdrArg);
  assert.equal(xdrArg.switch().name, 'scvString');
  assert.equal(xdrArg.str().toString(), 'alice');
});

test('releaseHandle throws RegistryNotConfiguredError when registry is not configured', async () => {
  delete process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID;
  assert.equal(isRegistryConfigured(), false);
  await assert.rejects(
    async () => {
      await releaseHandle('alice', WALLET);
    },
    (err: unknown) => {
      assert.ok(err instanceof RegistryNotConfiguredError);
      return true;
    },
  );
});
