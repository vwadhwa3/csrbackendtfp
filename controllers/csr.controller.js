const {
  HttpError,
  listMyTasksService,
  completeTaskService,
} = require("../services/csr.service");

const parseId = (value, name) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new HttpError(400, "INVALID_ID", `${name} must be a positive integer`);
  }
  return id;
};

const handleError = (res, error) => {
  if (error instanceof HttpError) {
    return res.status(error.status).json({
      success: false,
      error: error.code,
      message: error.message,
    });
  }

  console.error("CSR controller error:", error);
  return res.status(500).json({
    success: false,
    error: "INTERNAL_SERVER_ERROR",
    message: "An unexpected error occurred",
  });
};

// GET /api/csr/tasks?caseId=&status=open|resolved
const listMyTasks = async (req, res) => {
  try {
    const caseId =
      req.query.caseId !== undefined ? parseId(req.query.caseId, "caseId") : undefined;

    const tasks = await listMyTasksService(req.user.user_id, {
      caseId,
      status: req.query.status,
    });

    return res.status(200).json({ success: true, count: tasks.length, tasks });
  } catch (error) {
    return handleError(res, error);
  }
};

// POST /api/csr/tasks/:taskId/complete
const completeTask = async (req, res) => {
  try {
    const taskId = parseId(req.params.taskId, "taskId");
    const result = await completeTaskService(req.user.user_id, taskId, req.body, req.ip);

    return res.status(200).json({ success: true, message: "Task completed", ...result });
  } catch (error) {
    return handleError(res, error);
  }
};

module.exports = { listMyTasks, completeTask };
