'use strict';

const express = require('express');
const controller = require('../controllers/queryExecutorController');

const router = express.Router();

// Reading the command back is harmless, so it is open to any signed-in user;
// running it is not, and the controller gates that on being an administrator.
router.post('/preview', controller.previewCommand);
router.post('/', controller.runCommand);

module.exports = router;
