/**
 * MAIN-world content-script entry point.
 *
 * Kept separate from `interceptor.ts` so that module stays a side-effect-free
 * library the test suite can install and uninstall at will. Previously the
 * install ran at import time behind a check for a test-runner global, which put
 * test-environment knowledge into shipped code.
 */
import { installInterceptor } from './interceptor';

installInterceptor(window);
