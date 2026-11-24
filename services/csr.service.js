const { getPool } = require("../config/db");

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// App status ids (app_status table)
const AS = {
  APPLICATION_CREATED: 5,
  INFO_FOR_REVIEW: 28,
  VAC_ACCOUNT_CREATION: 2,
  APPOINTMENT_MONITORING: 3,
  APPOINTMENT_BOOKED: 4,
  DOCUMENTS_IN_TL_REVIEW: 26,
};

// Task type ids (s_task table)
const TASK_TYPE = {
  SHARE_INFO_FORM_LINK: 7, // T2
  INFO_FORM_REVIEW: 2, // T3
  VAC_ACCOUNT_CREATION: 3, // T5
  PREPARE_DOCUMENTS: 45, // T7
  REVIEW_APPLICATION_INFO_TL: 47, // T4 (Team Lead's follow-up task)
};

// What a CSR may do per task type. T9 is intentionally not supported yet.
// from/to = the only allowed application status move (null = no status change).
const CSR_TASK_RULES = {
  [TASK_TYPE.SHARE_INFO_FORM_LINK]: { code: "T2", needsApplication: false, from: null, to: null },
  [TASK_TYPE.INFO_FORM_REVIEW]: {
    code: "T3",
    needsApplication: true,
    from: AS.APPLICATION_CREATED,
    to: AS.INFO_FOR_REVIEW,
    event: "A6",
    createTeamLeadTask: true,
  },
  [TASK_TYPE.VAC_ACCOUNT_CREATION]: {
    code: "T5",
    needsApplication: true,
    from: AS.VAC_ACCOUNT_CREATION,
    to: AS.APPOINTMENT_MONITORING,
    event: "A9",
    needsVacCredentials: true,
  },
  [TASK_TYPE.PREPARE_DOCUMENTS]: {
    code: "T7",
    needsApplication: true,
    from: AS.APPOINTMENT_BOOKED,
    to: AS.DOCUMENTS_IN_TL_REVIEW,
    event: "A11",
  },
};

// open / resolved are the CSR-facing names; DB values stay as they are.
const STATUS_FILTER = {
  open: ["pending", "in_progress"],
  resolved: ["completed"],
};

/* ---------------- list / view my tasks ---------------- */

const fullName = (first, surname) => [first, surname].filter(Boolean).join(" ") || null;

// Shared by the list and the detail view. Read-only.
// A CSR only gets tasks assigned to them, on cases assigned to them.
const TASK_SELECT = `
  SELECT t.task_id, t.case_id, t.application_id, t.task_type_id,
         s.task_type_code, s.label AS task_label,
         t.status, t.description, t.due_by, t.comments,
         t.creation_timestamp, t.updated_by, t.updation_timestamp,
         a.status_id AS application_status_id, st.label AS application_status_label,
         a.applicant_id,
         ap.first_name AS applicant_first_name, ap.surname AS applicant_surname,
         c.lead_contact_id,
         ld.first_name AS lead_first_name, ld.surname AS lead_surname,
         f.form_id, f.status AS form_status, f.submitted_at AS form_submitted_at
    FROM task t
    JOIN b_case c ON c.case_id = t.case_id
LEFT JOIN s_task s ON s.task_type_id = t.task_type_id
LEFT JOIN b_applications a ON a.application_id = t.application_id
LEFT JOIN app_status st ON st.status_id = a.status_id
LEFT JOIN b_contact ap ON ap.contact_id = a.applicant_id
LEFT JOIN b_contact ld ON ld.contact_id = c.lead_contact_id
LEFT JOIN application_form f ON f.application_id = t.application_id AND f.discontinued_at IS NULL
   WHERE t.assigned_to_user_id = $1
     AND c.assigned_csr_user_id = $1
     AND t.discontinued_at IS NULL`;

const shapeTask = (row) => {
  const {
    applicant_id, applicant_first_name, applicant_surname,
    lead_contact_id, lead_first_name, lead_surname,
    form_id, form_status, form_submitted_at,
    ...task
  } = row;

  return {
    ...task,
    // The task shows who the applicant is and which case it belongs to.
    applicant: task.application_id
      ? { applicantId: applicant_id, name: fullName(applicant_first_name, applicant_surname) }
      : null,
    case: {
      caseId: task.case_id,
      leadContactId: lead_contact_id,
      leadName: fullName(lead_first_name, lead_surname),
    },
    form: form_id ? { formId: form_id, status: form_status, submittedAt: form_submitted_at } : null,
    state: STATUS_FILTER.resolved.includes(task.status) ? "resolved" : "open",
    completable: Boolean(CSR_TASK_RULES[task.task_type_id]),
  };
};

const listMyTasksService = async (csrUserId, { caseId, status = "open" }) => {
  const statuses = STATUS_FILTER[status];
  if (!statuses) {
    throw new HttpError(400, "INVALID_STATUS", "status must be 'open' or 'resolved'");
  }

  const params = [csrUserId, statuses];
  let caseFilter = "";
  if (caseId !== undefined) {
    params.push(caseId);
    caseFilter = `AND t.case_id = $${params.length}`;
  }

  const result = await getPool().query(
    `${TASK_SELECT}
        AND t.status = ANY($2)
        ${caseFilter}
      ORDER BY t.due_by NULLS LAST, t.task_id`,
    params,
  );

  return result.rows.map(shapeTask);
};

// GET one task (same ownership rules as the list).
const getMyTaskService = async (csrUserId, taskId) => {
  const result = await getPool().query(`${TASK_SELECT} AND t.task_id = $2`, [csrUserId, taskId]);
  if (!result.rows[0]) {
    // Same answer whether it doesn't exist or belongs to someone else.
    throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
  }
  return shapeTask(result.rows[0]);
};

/* ---------------- complete a task (+ move status) ---------------- */

const completeTaskService = async (csrUserId, taskId, body, ip) => {
  const { comments, vacAlias, vacPassword } = body || {};
  const who = String(csrUserId);
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");

    // Lock the task, but only if it belongs to this CSR and this CSR's case.
    const taskRes = await client.query(
      `SELECT t.*
         FROM task t
         JOIN b_case c ON c.case_id = t.case_id
        WHERE t.task_id = $1
          AND t.assigned_to_user_id = $2
          AND c.assigned_csr_user_id = $2
          AND t.discontinued_at IS NULL
        FOR UPDATE OF t`,
      [taskId, csrUserId],
    );
    const task = taskRes.rows[0];
    if (!task) {
      // Same answer whether it doesn't exist or belongs to someone else.
      throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    }

    const rule = CSR_TASK_RULES[task.task_type_id];
    if (!rule) {
      throw new HttpError(400, "TASK_NOT_SUPPORTED", "This task type cannot be completed from the CSR site");
    }
    if (!["pending", "in_progress"].includes(task.status)) {
      throw new HttpError(409, "TASK_ALREADY_RESOLVED", `Task is already ${task.status}`);
    }
    if (rule.needsApplication && !task.application_id) {
      throw new HttpError(409, "NO_APPLICATION", "Task is not linked to an application");
    }
    if (rule.needsVacCredentials && (!vacAlias?.trim() || !vacPassword)) {
      throw new HttpError(400, "VAC_CREDENTIALS_REQUIRED", "vacAlias and vacPassword are required");
    }

    // Move the application status (state rule check).
    if (rule.to !== null) {
      const appRes = await client.query(
        `SELECT application_id, status_id FROM b_applications
          WHERE application_id = $1 AND case_id = $2 AND discontinued_at IS NULL
          FOR UPDATE`,
        [task.application_id, task.case_id],
      );
      const app = appRes.rows[0];
      if (!app) {
        throw new HttpError(404, "APPLICATION_NOT_FOUND", "Application not found");
      }
      if (app.status_id !== rule.from) {
        throw new HttpError(
          409,
          "INVALID_STATE_TRANSITION",
          `Application must be in status ${rule.from} to complete ${rule.code}; it is in ${app.status_id}`,
        );
      }

      if (rule.needsVacCredentials) {
        await client.query(
          `UPDATE b_applications
              SET status_id = $1, vac_alias = $2, vac_password = $3,
                  updated_by = $4, updation_timestamp = now()
            WHERE application_id = $5`,
          [rule.to, vacAlias.trim(), vacPassword, who, app.application_id],
        );
      } else {
        await client.query(
          `UPDATE b_applications
              SET status_id = $1, updated_by = $2, updation_timestamp = now()
            WHERE application_id = $3`,
          [rule.to, who, app.application_id],
        );
      }

      // Audit: status change (never log the VAC password).
      await client.query(
        `INSERT INTO system_log
           (performed_by, table_name, record_id, action_type, old_state, new_state,
            field_changed, old_value, new_value, reason, task_id, case_id, application_id, ip_address)
         VALUES ($1,'b_applications',$2,'STATE_CHANGE',$3::varchar,$4::varchar,'status_id',$3::varchar,$4::varchar,$5,$6,$7,$2,$8)`,
        [
          who,
          app.application_id,
          String(rule.from),
          String(rule.to),
          JSON.stringify({ event: rule.event, task_completed: rule.code }),
          task.task_id,
          task.case_id,
          ip || null,
        ],
      );
    }

    // Complete the task: who + when go in updated_by / updation_timestamp.
    await client.query(
      `UPDATE task
          SET status = 'completed', comments = COALESCE($1, comments),
              updated_by = $2, updation_timestamp = now()
        WHERE task_id = $3`,
      [comments || null, who, task.task_id],
    );

    await client.query(
      `INSERT INTO system_log
         (performed_by, table_name, record_id, action_type, old_state, new_state,
          field_changed, old_value, new_value, reason, task_id, case_id, application_id, ip_address)
       VALUES ($1,'task',$2,'TASK_COMPLETED',$3::varchar,'completed','status',$3::varchar,'completed',$4,$2,$5,$6,$7)`,
      [
        who,
        task.task_id,
        task.status,
        comments || `${rule.code} completed by CSR`,
        task.case_id,
        task.application_id,
        ip || null,
      ],
    );

    // T3: the CSR never picks a Team Lead (only the SPOC does, at case creation).
    // We just hand over to the Team Lead already stored on the case.
    let teamLeadTaskId = null;
    if (rule.createTeamLeadTask) {
      const caseRes = await client.query(
        `SELECT assigned_team_lead_user_id FROM b_case WHERE case_id = $1`,
        [task.case_id],
      );
      const teamLeadId = caseRes.rows[0]?.assigned_team_lead_user_id;
      if (!teamLeadId) {
        throw new HttpError(409, "NO_TEAM_LEAD", "No Team Lead is assigned to this case");
      }

      const description = `Review Application Information. Application ID: ${task.application_id}`;
      const created = await client.query(
        `INSERT INTO task
           (case_id, application_id, task_type_id, assigned_to_user_id, role_required,
            status, description, created_by_user_id, created_by)
         VALUES ($1,$2,$3,$4,'Team Lead','pending',$5,$6,$7)
         RETURNING task_id`,
        [task.case_id, task.application_id, TASK_TYPE.REVIEW_APPLICATION_INFO_TL, teamLeadId, description, csrUserId, who],
      );
      teamLeadTaskId = created.rows[0].task_id;

      await client.query(
        `INSERT INTO system_log
           (performed_by, table_name, record_id, action_type, new_state, reason,
            task_id, case_id, application_id, ip_address)
         VALUES ($1,'task',$2,'TASK_CREATED','pending',$3,$2,$4,$5,$6)`,
        [who, teamLeadTaskId, `T4 created for Team Lead after CSR completed ${rule.code}`, task.case_id, task.application_id, ip || null],
      );
    }

    await client.query("COMMIT");

    return {
      taskId: task.task_id,
      taskCode: rule.code,
      taskStatus: "completed",
      application:
        rule.to === null ? null : { applicationId: task.application_id, oldStatusId: rule.from, newStatusId: rule.to },
      teamLeadTaskId,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

module.exports = { HttpError, listMyTasksService, getMyTaskService, completeTaskService };
