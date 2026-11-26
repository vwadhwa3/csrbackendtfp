const { getPool } = require("../config/db");
const { createDocument, deleteDocument, GoogleDocsError } = require("./googleDocs.service");
const { buildPreparedDocumentHtml, buildInvoiceHtml } = require("./docTemplates");

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

// s_user.user_role_type_id values (same ids as middleware/role.middleware.js)
const ROLE_CSR = 2;
const ROLE_LEAD_CONSULTANT = 4;
const ROLE_TEAM_LEAD = 26;

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

/* ---------------- Prepare: Google Doc + invoice (Appointment Booked) ---------------- */

// The doc link is stored in the existing `attachment` table (no schema change):
// application_id + url_path = link, document_type_id NULL, file_name = the marker below.
const PREPARED_DOCS = {
  preparedDocument: {
    fileName: "Prepared Documents (Google Doc)",
    title: (id) => `Prepared Documents - Application ${id}`,
    html: buildPreparedDocumentHtml,
    reason: "Prepared documents Google Doc created",
  },
  invoice: {
    fileName: "Invoice (Google Doc)",
    title: (id) => `Invoice INV-A${id}`,
    html: buildInvoiceHtml,
    reason: "Invoice Google Doc created",
  },
};

const PREPARED_FILE_NAMES = Object.values(PREPARED_DOCS).map((d) => d.fileName);

// No download link is ever returned: view/edit happens in Google Docs only.
const shapeDoc = (row) => ({
  attachmentId: row.attachment_id,
  name: row.file_name,
  url: row.url_path,
  createdAt: row.creation_timestamp,
  canDownload: false,
});

const shapePrepared = (rows) => {
  const byName = Object.fromEntries(rows.map((r) => [r.file_name, r]));
  const pick = (kind) => {
    const row = byName[PREPARED_DOCS[kind].fileName];
    return row ? shapeDoc(row) : null;
  };
  return { preparedDocument: pick("preparedDocument"), invoice: pick("invoice") };
};

const PREPARED_ROWS_SQL = `
  SELECT attachment_id, file_name, url_path, creation_timestamp
    FROM attachment
   WHERE application_id = $1
     AND document_type_id IS NULL
     AND file_name = ANY($2)
     AND discontinued_at IS NULL
   ORDER BY attachment_id`;

// POST: create the application's Google Doc (and invoice) once; later calls return the same ones.
const prepareApplicationService = async (csrUserId, applicationId, ip) => {
  const who = String(csrUserId);
  const client = await getPool().connect();
  const createdFileIds = []; // Google files made in this call (removed again if we fail)

  try {
    await client.query("BEGIN");

    // The row lock makes two quick clicks wait for each other: the second one
    // then finds the first one's doc instead of creating another.
    const appRes = await client.query(
      `SELECT a.application_id, a.case_id, a.applicant_id, a.status_id,
              a.appointment_date, a.appointment_location,
              c.lead_contact_id, c.assigned_team_lead_user_id,
              c.initial_deposit_received, c.balance_received, c.balance_amount_due, c.discount_amount,
              cur.iso_code AS currency
         FROM b_applications a
         JOIN b_case c ON c.case_id = a.case_id
    LEFT JOIN currency cur ON cur.currency_id = c.currency_id
        WHERE a.application_id = $1
          AND a.discontinued_at IS NULL
          AND c.assigned_csr_user_id = $2
        FOR UPDATE OF a`,
      [applicationId, csrUserId],
    );
    const app = appRes.rows[0];
    if (!app) {
      // Same answer whether it doesn't exist or belongs to another CSR.
      throw new HttpError(404, "APPLICATION_NOT_FOUND", "Application not found");
    }

    const existing = await client.query(PREPARED_ROWS_SQL, [applicationId, PREPARED_FILE_NAMES]);
    const have = new Set(existing.rows.map((r) => r.file_name));
    const missing = Object.values(PREPARED_DOCS).filter((d) => !have.has(d.fileName));

    if (missing.length === 0) {
      await client.query("ROLLBACK");
      return { created: false, ...shapePrepared(existing.rows) };
    }

    if (app.status_id !== AS.APPOINTMENT_BOOKED) {
      throw new HttpError(
        409,
        "INVALID_STATE",
        `Documents can only be prepared when the application is at Appointment Booked (status ${AS.APPOINTMENT_BOOKED}); it is in ${app.status_id}`,
      );
    }

    // Who may open/edit the docs: this CSR, the case's Team Lead, and the Lead Consultant(s).
    const usersRes = await client.query(
      `SELECT DISTINCT lower(trim(email)) AS email
         FROM s_user
        WHERE (user_id = $1 OR user_id = $2 OR user_role_type_id = $3)
          AND is_active = 1
          AND discontinued_at IS NULL
          AND email IS NOT NULL AND trim(email) <> ''`,
      [csrUserId, app.assigned_team_lead_user_id, ROLE_LEAD_CONSULTANT],
    );
    const editorEmails = usersRes.rows.map((r) => r.email);

    const namesRes = await client.query(
      `SELECT contact_id, first_name, surname FROM b_contact WHERE contact_id = ANY($1::bigint[])`,
      [[app.applicant_id, app.lead_contact_id]],
    );
    const checklistRes = await client.query(
      `SELECT dt.name, l.is_required, l.is_received
         FROM app_doc_checklist l
         JOIN document_type dt ON dt.document_type_id = l.document_type_id
        WHERE l.application_id = $1 AND l.discontinued_at IS NULL
        ORDER BY l.checklist_id`,
      [applicationId],
    );
    const nameOf = (id) => {
      const c = namesRes.rows.find((r) => String(r.contact_id) === String(id));
      return c ? fullName(c.first_name, c.surname) : null;
    };

    const data = {
      applicationId: app.application_id,
      caseId: app.case_id,
      applicantName: nameOf(app.applicant_id),
      leadName: nameOf(app.lead_contact_id),
      appointmentDate: app.appointment_date,
      appointmentLocation: app.appointment_location,
      checklist: checklistRes.rows,
      currency: app.currency,
      initialDepositReceived: app.initial_deposit_received,
      balanceReceived: app.balance_received,
      balanceAmountDue: app.balance_amount_due,
      discountAmount: app.discount_amount,
      issuedAt: new Date(),
    };

    for (const def of missing) {
      const doc = await createDocument({ title: def.title(app.application_id), html: def.html(data), editorEmails });
      createdFileIds.push(doc.fileId);

      const ins = await client.query(
        `INSERT INTO attachment
           (case_id, application_id, document_type_id, file_name, file_path, url_path,
            uploaded_by_customer, uploaded_by_user_id, created_by)
         VALUES ($1,$2,NULL,$3,$4,$4,0,$5,$6)
         RETURNING attachment_id`,
        [app.case_id, app.application_id, def.fileName, doc.url, csrUserId, who],
      );

      await client.query(
        `INSERT INTO system_log
           (performed_by, table_name, record_id, action_type, field_changed, new_value,
            reason, case_id, application_id, ip_address)
         VALUES ($1,'attachment',$2,'PREPARED_DOC_CREATED','url_path',$3,$4,$5,$6,$7)`,
        [who, ins.rows[0].attachment_id, doc.url, def.reason, app.case_id, app.application_id, ip || null],
      );
    }

    const finalRows = await client.query(PREPARED_ROWS_SQL, [applicationId, PREPARED_FILE_NAMES]);
    await client.query("COMMIT");

    return { created: true, ...shapePrepared(finalRows.rows) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    // Nothing was saved, so remove any Google file made in this call: a retry starts clean.
    await Promise.all(createdFileIds.map((id) => deleteDocument(id)));

    if (error instanceof GoogleDocsError) {
      if (error.code === "GOOGLE_NOT_CONFIGURED") {
        throw new HttpError(503, error.code, "Google Docs is not configured on the server");
      }
      throw new HttpError(502, error.code, "Could not reach Google Docs. Nothing was created; please try again.");
    }
    throw error;
  } finally {
    client.release();
  }
};

// GET: read the saved links. CSR (own case), Team Lead (own case), Lead Consultant (any case).
const getPreparedDocumentsService = async (user, applicationId) => {
  const roleId = Number(user.user_role_type_id);
  const params = [applicationId];
  let scope = "";

  if (roleId === ROLE_CSR) {
    params.push(user.user_id);
    scope = `AND c.assigned_csr_user_id = $${params.length}`;
  } else if (roleId === ROLE_TEAM_LEAD) {
    params.push(user.user_id);
    scope = `AND c.assigned_team_lead_user_id = $${params.length}`;
  } else if (roleId !== ROLE_LEAD_CONSULTANT) {
    throw new HttpError(403, "FORBIDDEN", "You do not have permission to access this resource");
  }

  const appRes = await getPool().query(
    `SELECT a.application_id
       FROM b_applications a
       JOIN b_case c ON c.case_id = a.case_id
      WHERE a.application_id = $1 AND a.discontinued_at IS NULL ${scope}`,
    params,
  );
  if (!appRes.rows[0]) {
    throw new HttpError(404, "APPLICATION_NOT_FOUND", "Application not found");
  }

  const rows = await getPool().query(PREPARED_ROWS_SQL, [applicationId, PREPARED_FILE_NAMES]);
  const prepared = shapePrepared(rows.rows);
  return { applicationId, prepared: Boolean(prepared.preparedDocument), ...prepared };
};

module.exports = {
  HttpError,
  listMyTasksService,
  getMyTaskService,
  completeTaskService,
  prepareApplicationService,
  getPreparedDocumentsService,
};
