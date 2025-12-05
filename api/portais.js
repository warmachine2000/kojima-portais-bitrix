const axios = require("axios");

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

  try {
    const resp = await axios.post(url, params, { timeout: 15000 });

    // Bitrix retornou 200 mas com erro lógico
    if (resp.data && resp.data.error) {
      throw new Error(
        `BITRIX_API_ERROR [${method}] ${resp.data.error}: ${
          resp.data.error_description || ""
        }`
      );
    }

    return resp.data.result;
  } catch (err) {
    if (err.response) {
      console.error(
        `Bitrix request FAILED [${method}]`,
        err.response.status,
        JSON.stringify(err.response.data, null, 2)
      );

      throw new Error(
        `BITRIX_REQUEST_FAILED (${err.response.status}) [${method}]: ${JSON.stringify(
          err.response.data
        )}`
      );
    }

    throw err; // timeout, DNS, rede etc
  }
}

async function findDuplicate(phones, email) {
  let duplicates = { PHONE: null, EMAIL: null };

  if (phones?.length) {
    try {
      const resultPhone = await bitrixCall("crm.duplicate.findbycomm", {
        type: "PHONE",
        values: phones,
      });
      duplicates.PHONE = resultPhone;
    } catch (e) {
      console.warn("Erro duplicidade telefone:", e.message);
    }
  }

  if (email) {
    try {
      const resultEmail = await bitrixCall("crm.duplicate.findbycomm", {
        type: "EMAIL",
        values: [email],
      });
      duplicates.EMAIL = resultEmail;
    } catch (e) {
