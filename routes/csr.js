const express = require("express");

const { authenticate } = require("../middleware/auth.middleware");
const { ROLES, requireRole } = require("../middleware/role.middleware");
const { listMyTasks, completeTask } = require("../controllers/csr.controller");

const router = express.Router();

// Every CSR route: logged in, and role must be CSR (checked on the server).
router.use(authenticate, requireRole(ROLES.CSR));

router.get("/tasks", listMyTasks);
router.post("/tasks/:taskId/complete", completeTask);

module.exports = router;
