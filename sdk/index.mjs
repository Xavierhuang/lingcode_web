// ESM entry for lingcode-js. The implementation lives in the UMD file
// lingcode-v1.js (one source of truth, also served at lingcode.dev/sdk and used
// as the browser <script> build). Node ESM + bundlers interop the CJS default
// export; this shim re-exports it as named + default ESM bindings.
import LingCode from './lingcode-v1.js';

export const createClient = LingCode.createClient;
export const version = LingCode.version;
export default LingCode;
