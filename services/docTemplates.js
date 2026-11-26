// HTML bodies for the Google Docs (Google converts the HTML into a native Doc).
// Every dynamic value is escaped.

const esc = (value) =>
  String(value ?? "—")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const money = (amount, iso) => `${esc(iso || "")} ${Number(amount || 0).toFixed(2)}`.trim();

const dateText = (value) => (value ? new Date(value).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—");

const row = (label, value) => `<tr><td><b>${esc(label)}</b></td><td>${esc(value)}</td></tr>`;

const page = (title, inner) =>
  `<html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1>${inner}</body></html>`;

const buildPreparedDocumentHtml = (d) => {
  const checklist = d.checklist.length
    ? `<table border="1" cellpadding="4"><tr><th>Document</th><th>Required</th><th>Received</th></tr>${d.checklist
        .map(
          (c) =>
            `<tr><td>${esc(c.name)}</td><td>${c.is_required ? "Yes" : "No"}</td><td>${c.is_received ? "Yes" : "No"}</td></tr>`,
        )
        .join("")}</table>`
    : "<p>No document checklist has been saved for this application yet.</p>";

  return page(
    `Prepared Documents — Application ${d.applicationId}`,
    `<table border="1" cellpadding="4">${[
      row("Application ID", d.applicationId),
      row("Case ID", d.caseId),
      row("Applicant", d.applicantName),
      row("Lead contact", d.leadName),
      row("Appointment date", dateText(d.appointmentDate)),
      row("Appointment location", d.appointmentLocation),
    ].join("")}</table><h2>Document checklist</h2>${checklist}<h2>Notes</h2><p></p>`,
  );
};

const buildInvoiceHtml = (d) => {
  const paid = Number(d.initialDepositReceived || 0) + Number(d.balanceReceived || 0);
  const remaining = Number(d.balanceAmountDue || 0);
  return page(
    `Invoice INV-A${d.applicationId}`,
    `<table border="1" cellpadding="4">${[
      row("Invoice for application", d.applicationId),
      row("Case ID", d.caseId),
      row("Applicant", d.applicantName),
      row("Lead contact", d.leadName),
      row("Issued", dateText(d.issuedAt)),
    ].join("")}</table>
     <h2>Payments</h2>
     <table border="1" cellpadding="4">
       <tr><td><b>Initial deposit received</b></td><td>${money(d.initialDepositReceived, d.currency)}</td></tr>
       <tr><td><b>Balance payments received</b></td><td>${money(d.balanceReceived, d.currency)}</td></tr>
       <tr><td><b>Discount applied</b></td><td>${money(d.discountAmount, d.currency)}</td></tr>
       <tr><td><b>Total amount paid</b></td><td><b>${money(paid, d.currency)}</b></td></tr>
       <tr><td><b>Balance remaining</b></td><td><b>${money(remaining, d.currency)}</b></td></tr>
     </table>
     <p>Amounts are for the whole case.</p>`,
  );
};

module.exports = { buildPreparedDocumentHtml, buildInvoiceHtml };
