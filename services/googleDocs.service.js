const { GoogleAuth } = require("google-auth-library");

// Thin Google Drive/Docs wrapper (REST via google-auth-library, no extra SDK).
//
// Env:
//   GOOGLE_SERVICE_ACCOUNT_JSON   service-account key JSON (raw JSON or base64 of it)
//                                 (or GOOGLE_APPLICATION_CREDENTIALS = path to the key file)
//   GOOGLE_DRIVE_FOLDER_ID        folder (or shared drive folder) the docs are created in
//   GOOGLE_IMPERSONATE_USER       optional: Workspace user to act as (domain-wide delegation)
//   GOOGLE_REQUEST_TIMEOUT_MS     optional, default 15000
//
// Only the Drive scope is needed. The Google Doc is created by uploading HTML
// that Google converts into a native Google Doc (keeps headings and tables).

const DRIVE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

class GoogleDocsError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.code = code; // GOOGLE_NOT_CONFIGURED | GOOGLE_UNAVAILABLE
    this.cause = cause;
  }
}

let authClientPromise = null;

const loadCredentials = () => {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;

  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const credentials = JSON.parse(text);
  // .env files often store the key with literal "\n" sequences.
  if (typeof credentials.private_key === "string") {
    credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
  }
  return credentials;
};

const getClient = () => {
  if (!process.env.GOOGLE_DRIVE_FOLDER_ID) {
    throw new GoogleDocsError("GOOGLE_NOT_CONFIGURED", "Google Docs is not configured (GOOGLE_DRIVE_FOLDER_ID)");
  }

  if (!authClientPromise) {
    let credentials;
    try {
      credentials = loadCredentials();
    } catch (error) {
      throw new GoogleDocsError("GOOGLE_NOT_CONFIGURED", "GOOGLE_SERVICE_ACCOUNT_JSON is not valid", error);
    }
    if (!credentials && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      throw new GoogleDocsError("GOOGLE_NOT_CONFIGURED", "Google Docs credentials are not configured");
    }

    const auth = new GoogleAuth({
      ...(credentials ? { credentials } : {}),
      scopes: ["https://www.googleapis.com/auth/drive"],
      ...(process.env.GOOGLE_IMPERSONATE_USER ? { clientOptions: { subject: process.env.GOOGLE_IMPERSONATE_USER } } : {}),
    });
    authClientPromise = auth.getClient().catch((error) => {
      authClientPromise = null; // allow a retry on the next call
      throw error;
    });
  }
  return authClientPromise;
};

const request = async (options) => {
  const client = await getClient();
  return client.request({
    timeout: Number(process.env.GOOGLE_REQUEST_TIMEOUT_MS) || 15000,
    // Never auto-retry: a retried create could produce a duplicate doc.
    retry: false,
    ...options,
  });
};

const wrap = (error) => {
  if (error instanceof GoogleDocsError) return error;
  const status = error?.response?.status;
  const reason = error?.response?.data?.error?.message || error?.message;
  console.error("Google API error:", status || "", reason);
  return new GoogleDocsError("GOOGLE_UNAVAILABLE", "Could not reach Google Docs", error);
};

const docUrl = (fileId) => `https://docs.google.com/document/d/${fileId}/edit`;

// Best effort; used to undo a half-finished create so no orphan doc is left.
const deleteDocument = async (fileId) => {
  try {
    await request({ url: `${DRIVE}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, method: "DELETE" });
    return true;
  } catch (error) {
    console.error("Google cleanup failed for", fileId, error?.response?.data?.error?.message || error.message);
    return false;
  }
};

// Creates a private Google Doc from HTML and shares it (edit) with `editorEmails` only.
// If anything fails after the file exists, the file is deleted again.
const createDocument = async ({ title, html, editorEmails }) => {
  let fileId = null;
  try {
    const boundary = `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    const metadata = {
      name: title,
      mimeType: "application/vnd.google-apps.document",
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
      // Viewers/commenters cannot download, print or copy; editors cannot re-share.
      copyRequiresWriterPermission: true,
      writersCanShare: false,
    };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`;

    const created = await request({
      url: `${DRIVE_UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id`,
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    fileId = created.data?.id;
    if (!fileId) throw new Error("Google returned no file id");

    for (const emailAddress of editorEmails) {
      await request({
        url: `${DRIVE}/files/${encodeURIComponent(fileId)}/permissions?sendNotificationEmail=false&supportsAllDrives=true`,
        method: "POST",
        data: { type: "user", role: "writer", emailAddress },
      });
    }

    return { fileId, url: docUrl(fileId) };
  } catch (error) {
    if (fileId) await deleteDocument(fileId);
    throw wrap(error);
  }
};

module.exports = { GoogleDocsError, createDocument, deleteDocument, docUrl };
