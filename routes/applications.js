const express = require("express");

const { authenticate } = require("../middleware/auth.middleware");
const { ROLES, requireRole } = require("../middleware/role.middleware");
const { getPreparedDocuments } = require("../controllers/csr.controller");

const router = express.Router();

// Read-only links to the prepared Google Docs, for the roles that review them.
// Ownership (own case for CSR / Team Lead) is checked again in the service.
router.get(
  "/:applicationId/prepared-documents",
  authenticate,
  requireRole(ROLES.CSR, ROLES.TEAM_LEAD, ROLES.LEAD_CONSULTANT),
  getPreparedDocuments,
);

module.exports = router;
