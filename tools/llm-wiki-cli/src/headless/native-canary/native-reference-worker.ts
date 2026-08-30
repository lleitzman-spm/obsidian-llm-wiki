import { startIsolatedInjectedWorker } from '../isolation';
import { runNativeReferenceIsolatedWorker } from './host';

/**
 * Production worker entrypoint for the native-reference child. A bundler
 * should emit this module as the regular-file `workerScript` supplied to
 * `createIsolatedInjectedRunner`.
 */
startIsolatedInjectedWorker(runNativeReferenceIsolatedWorker);
