const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || null;

// ----------------- Funções auxiliares -----------------

function parsePhones(phoneStr) {
  if (!phoneStr) return [];
  return phoneStr
    .split(/[\/,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function extractCodigoImovel(message) {
  if (!message) return null;
  const regex = /\((?:Código|Codigo|código)\s+([A-Z0-9\-]+)\)/i;
  const match = message.match(regex);
  return match ? match[1] : null;
}

async function bitrixCall(method, params) {
  if (!BITRIX_WEBHOOK_URL) {
    throw new Error("BITRIX_WEBHOOK_URL não definido nas variáveis de ambiente");
  }

  const url = `${BITRIX_WEBHOOK_URL}/${method}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    console.error(
      `Bitrix request FAILED [${method}]`,
      resp.status,
      JSON.stringify(data, null, 2)
    );
    throw new Error(
      `BITRIX_REQUEST_FAILED (${resp.status}) [${method}]: ${JSON.stringify(
        data
      )}`
    );
  }

  if (data && data.error) {
    throw new Error(
      `BITRIX_API_ERROR [${method}] ${data.error}: ${
        data.error_description || ""
      }`
    );
  }

  return data.result;
}

async function findDuplicate(phones, email) {
  let duplicates = { PHONE: null, EMAIL: null };

  if (phones?.length) {
    try {
      duplicates.PHONE = await bitrixCall("crm.duplicate.findbycomm", {
        type: "PHONE",
        values: phones,
      });
    } catch (e) {
      console.warn("Erro duplicidade telefone:", e.message);
    }
  }

  if (email) {
    try {
      duplicates.EMAIL = await bitrixCall("crm.duplicate.findbycomm", {
        type: "EMAIL",
        values: [email],
      });
    } catch (e) {
      console.warn("Erro duplicidade email:", e.message);
    }
  }

  return duplicates;
}

function hasLeadDuplicate(duplicates) {
  if (!duplicates) return false;

  const leadIdsPhone = duplicates.PHONE?.LEAD || [];
  const leadIdsE
