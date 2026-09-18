'use strict';

const express = require('express');
const controller = require('../controllers/monitorController');

const router = express.Router();

// Read-only: serverStatus and hostInfo on the cluster in session. There is no
// write here and there never should be — this endpoint exists to watch the
// server, and a monitor that can change what it measures is not one.
router.get('/live', controller.live);

module.exports = router;
