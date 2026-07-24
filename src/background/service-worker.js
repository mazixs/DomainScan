// DomainScan Manifest V3 service-worker entry point.
// Chrome-specific listeners are registered by the injectable controller so lifecycle behavior can
// be verified in Node without weakening the production extension.

import { createBackgroundController } from './controller.js';

createBackgroundController(chrome);
