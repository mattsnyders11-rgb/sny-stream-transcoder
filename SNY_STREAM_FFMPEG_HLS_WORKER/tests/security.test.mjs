import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSourceUrl } from '../server/security.js';

test('rejects Real-Debrid URLs before a worker job can be created', async () => {
  await assert.rejects(
    validateSourceUrl('https://download.real-debrid.com/d/temporary-file'),
    error => {
      assert.equal(error.code, 'PROVIDER_NATIVE_PLAYBACK_REQUIRED');
      assert.equal(error.retryable, false);
      return true;
    }
  );
});
