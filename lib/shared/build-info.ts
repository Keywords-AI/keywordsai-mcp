// Build-time deployment stamp.
//
// The values below are placeholders in source control. The Vercel build command
// runs `scripts/stamp-build-info.mjs`, which rewrites this file with the commit
// being deployed so `/health` and `server_info` can report it even when the
// `VERCEL_GIT_*` system env vars are not exposed to the function at runtime.
// Do not edit by hand; do not commit a stamped version.
export const BUILD_COMMIT_SHA = 'unknown';
export const BUILD_BRANCH = 'unknown';
export const BUILD_TIMESTAMP = '';
