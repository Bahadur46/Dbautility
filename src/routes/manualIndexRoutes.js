'use strict';

const express = require('express');
const controller = require('../controllers/manualIndexController');
const { validate, validateObjectId } = require('../middleware/validate');
const { validateCreate } = require('../validators/manualIndexValidator');

const router = express.Router();

// Static segments must be declared before the /:id routes.
router.get('/stats/summary', controller.getSummary);
router.get('/meta/collections', controller.getCollections);
router.get('/meta/databases', controller.getDatabases);
router.get('/meta/fields', controller.getFields);

router
  .route('/')
  .get(controller.getManualIndexes)
  .post(validate(validateCreate), controller.createManualIndex);

// Live comparison of a definition against MongoDB, and forced re-sync.
router.get('/:id/db-status', validateObjectId('id'), controller.getDbStatus);
router.post('/:id/sync', validateObjectId('id'), controller.syncManualIndex);
// Removes the real index but keeps the definition — the gentler half of DELETE.
router.post('/:id/drop', validateObjectId('id'), controller.dropManualIndex);

router
  .route('/:id')
  .get(validateObjectId('id'), controller.getManualIndexById)
  // The update payload is merged with the stored record and validated inside
  // the controller, so a partial edit cannot produce an invalid definition.
  .put(validateObjectId('id'), controller.updateManualIndex)
  .delete(validateObjectId('id'), controller.deleteManualIndex);

module.exports = router;
