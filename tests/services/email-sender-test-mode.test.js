import { describe, it, expect, vi, beforeEach } from "vitest";

// Verifica ESPLICITA del gate richiesto dal task: con test_mode=true, un
// tentativo di invio verso un destinatario normale NON deve MAI produrre un
// invio SMTP reale a quel destinatario (mock su nodemailer.sendMail).

vi.mock("../../src/db.js", () => ({ query: vi.fn() }));
vi.mock("../../src/config.js", () => ({
  default: {
    jwtSecret: "x".repeat(32),
    magicLinkBaseUrl: "http://localhost:3000",
    nodeEnv: "test",
    emailFrom: "noreply@outreach.local",
    brand: {
      name: "Outreach Service",
      defaultFromName: "Outreach Service",
      supportEmail: "",
      supportUrl: "",
      refererUrl: "",
      openRouterTitle: "Outreach Service",
      footerCompany: "",
      footerVat: "",
      footerAddress: "",
      footerPhone: "",
    },
  },
}));
vi.mock("../../src/services/settings.js", () => ({ getSetting: vi.fn() }));

const sendMailMock = vi.fn().mockResolvedValue({});
const closeMock = vi.fn();
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: sendMailMock, close: closeMock })),
  },
}));

const { query } = await import("../../src/db.js");
const { getSetting } = await import("../../src/services/settings.js");
const { sendCampaignEmail, sendFollowUpEmail } = await import("../../src/services/email-sender.js");

const REAL_EMAIL = "cliente.reale@example.com";
const TEST_EMAIL = "test@interno.local";

const company = {
  id: 42,
  email: REAL_EMAIL,
  consent_status: "marketing",
  bozza_email: "Corpo email di prova",
  bozza_email_oggetto: "Oggetto di prova",
};
const smtpAccount = {
  smtp_host: "smtp.test.local",
  smtp_port: 465,
  smtp_user: "user",
  smtp_pass: "pass",
};

function mockSettings({ testMode }) {
  getSetting.mockImplementation((key) => (key === "test_mode" ? testMode : null));
}

function mockDb({ testRecipients = [] } = {}) {
  query.mockImplementation((sql) => {
    if (typeof sql === "string" && sql.includes("FROM test_recipients")) {
      return Promise.resolve({ rows: testRecipients.map((email) => ({ id: 1, email, note: null, created_at: new Date() })) });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe("gate test_mode end-to-end (sendCampaignEmail / sendFollowUpEmail)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("test_mode disattivo: sendCampaignEmail invia al destinatario reale", async () => {
    mockSettings({ testMode: "false" });
    mockDb();
    const trackingId = await sendCampaignEmail(company, smtpAccount, {}, null, {});
    expect(trackingId).toBeTruthy();
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0].to).toBe(REAL_EMAIL);
  });

  it("test_mode attivo con destinatario di test: MAI invio al reale, sempre deviato", async () => {
    mockSettings({ testMode: "true" });
    mockDb({ testRecipients: [TEST_EMAIL] });
    const trackingId = await sendCampaignEmail(company, smtpAccount, {}, null, {});
    expect(trackingId).toBeTruthy();
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const sentTo = sendMailMock.mock.calls[0][0].to;
    expect(sentTo).toBe(TEST_EMAIL);
    expect(sentTo).not.toBe(REAL_EMAIL);
    expect(sendMailMock.mock.calls[0][0].subject).toMatch(/^\[TEST\]/);
  });

  it("test_mode attivo SENZA destinatari di test: blocca, NESSUN invio SMTP di alcun tipo", async () => {
    mockSettings({ testMode: "true" });
    mockDb({ testRecipients: [] });
    const trackingId = await sendCampaignEmail(company, smtpAccount, {}, null, {});
    expect(trackingId).toBeNull();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("sendFollowUpEmail rispetta lo stesso gate (deviato, mai al reale)", async () => {
    mockSettings({ testMode: "true" });
    mockDb({ testRecipients: [TEST_EMAIL] });
    const trackingId = await sendFollowUpEmail(
      company,
      smtpAccount,
      { subject: "Follow-up", body: "Corpo follow-up", step_order: 1 },
      {}
    );
    expect(trackingId).toBeTruthy();
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0].to).toBe(TEST_EMAIL);
    expect(sendMailMock.mock.calls[0][0].to).not.toBe(REAL_EMAIL);
  });

  it("sendFollowUpEmail bloccato senza destinatari di test: nessun invio", async () => {
    mockSettings({ testMode: "true" });
    mockDb({ testRecipients: [] });
    const trackingId = await sendFollowUpEmail(
      company,
      smtpAccount,
      { subject: "Follow-up", body: "Corpo follow-up", step_order: 1 },
      {}
    );
    expect(trackingId).toBeNull();
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
