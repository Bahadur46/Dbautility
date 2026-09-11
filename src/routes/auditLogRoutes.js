'use strict';

const express = require('express');
const controller = require('../controllers/auditLogController');
const { validateObjectId } = require('../middleware/validate');

const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// The only two write-ish operations, declared before the blanket blockers below.
// Deleting a single chosen entry is deliberately not offered — see the audit
// integrity notes in the README.
// The export streams every entry it matches — IP addresses, user agents,
// full before/after values — and leaves no record that it happened. It is
// administrator-only, like the purge it exists to precede.
router.get('/export', requireAdmin, controller.exportAuditLogs);
router.get('/purge/preview', requireAdmin, controller.previewPurge);
router.post('/purge', requireAdmin, controller.purgeAuditLogs);

// Everything else that writes is rejected outright.
router.post('*', controller.rejectMutation);
router.put('*', controller.rejectMutation);
router.patch('*', controller.rejectMutation);
router.delete('*', controller.rejectMutation);

router.get('/filters/options', controller.getFilterOptions);
router.get('/', controller.getAuditLogs);
router.get('/:id', validateObjectId('id'), controller.getAuditLogById);

module.exports = router;
