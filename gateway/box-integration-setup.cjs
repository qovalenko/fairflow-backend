/**
 * Runs before box integration specs load (same Jest worker) so upload tests can
 * register as `it` when the box stand MinIO is reachable.
 */
module.exports = async () => {
  if (process.env.BOX_INTEGRATION !== '1') return;
  try {
    const { probeAndApplyBoxS3Env, probeBoxS3Detailed } = require('@fairflow/testing/dist/box/env');
    const detail = await probeBoxS3Detailed();
    const ok = await probeAndApplyBoxS3Env();
    if (ok) {
      console.log('[box-integration] the box stand S3 reachable with valid credentials — upload touchpoints enabled');
    } else if (detail.healthOk && !detail.credentialsOk) {
      process.env.BOX_S3_CREDENTIALS_BUG = '1';
      console.log(
        `[box-integration] MinIO up at ${detail.endpoint} but credentials rejected for ${detail.accessKeyId}` +
          (detail.error ? ` (${detail.error})` : '') +
          ' — upload touchpoints #17/#18/#25 registered as BUG skip',
      );
    } else {
      console.log('[box-integration] the box stand MinIO not reachable — upload touchpoints stay skipped');
    }
  } catch (error) {
    console.warn('[box-integration] S3 probe failed:', error);
  }
};
