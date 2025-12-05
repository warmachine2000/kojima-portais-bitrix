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

    throw err;
  }
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
  const leadIdsEmail = duplicates.EMAIL?.LEAD || [];

  return leadIdsPhone.length > 0 || leadIdsEmail.length > 0;
}

// ----------------- Handler Vercel -----------------

module.exports = async (req, res) => {
  try {
    console.log("=== INÍCIO /api/portais ===");

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (WEBHOOK_TOKEN) {
      const tokenHeader = req.headers["x-webhook-token"];
      if (tokenHeader !== WEBHOOK_TOKEN) {
        return res.status(401).json({ error: "INVALID_TOKEN" });
      }
    }

    let payload = {};

    if (!req.body) {
      return res.status(400).json({ error: "EMPTY_BODY" });
    }

    if (typeof req.body === "string") {
      try {
        payload = JSON.parse(req.body);
      } catch (e) {
        return res.status(400).json({ error: "INVALID_JSON" });
      }
    } else {
      payload = req.body;
    }

    console.log("Payload recebido:", JSON.stringify(payload, null, 2));

    const {
      eventId,
      contactId,
      messageId,
      internalReference,
      message,
      idNavplat,
      phone,
      clientCode,
      name,
      publicationPlan,
      userIdNavplat,
      contactTypeId,
      email,
      registerDate,
    } = payload;

    if (!name && !email && !phone) {
      return res
        .status(400)
        .json({ error: "Precisa de nome, e-mail ou telefone" });
    }

    const phones = parsePhones(phone);
    const codigoImovel = extractCodigoImovel(message) || "NÃO INFORMADO";

    const duplicates = await findDuplicate(phones, email);
    const isDuplicate = hasLeadDuplicate(duplicates);

    let leadId = null;

    // ------------------ DUPLICADO → CRIA ACTIVITY ------------------

    if (isDuplicate) {
      const leadFromPhone = duplicates.PHONE?.LEAD?.[0];
      const leadFromEmail = duplicates.EMAIL?.LEAD?.[0];

      leadId = leadFromPhone || leadFromEmail;

      const comms = [];

      if (phones.length) {
        comms.push({
          TYPE: "PHONE",
          VALUE: phones[0],
          ENTITY_TYPE_ID: 1,
          ENTITY_ID: leadId,
        });
      }

      if (email) {
        comms.push({
          TYPE: "EMAIL",
          VALUE: email,
          ENTITY_TYPE_ID: 1,
          ENTITY_ID: leadId,
        });
      }

      await bitrixCall("crm.activity.add", {
        fields: {
          OWNER_ID: leadId,
          OWNER_TYPE_ID: 1,
          TYPE_ID: 4,
          SUBJECT: `Novo contato Portal (duplicado) - ${codigoImovel}`,
          DESCRIPTION:
            `Novo contato vindo do portal.\n\n` +
            `Mensagem: ${message || ""}\n\n` +
            `Telefones: ${phones.join(", ") || "não informado"}\n` +
            `E-mail: ${email || "não informado"}`,
          RESPONSIBLE_ID: 1,
          COMPLETED: "N",
          COMMUNICATIONS: comms,
        },
      });

      return res.json({
        status: "DUPLICATE_ACTIVITY_CREATED",
        leadId,
      });
    }

    // ------------------ NOVO LEAD ------------------

    const leadFields = {
      TITLE: `Lead Portal | ${codigoImovel} | ${name || "Sem nome"}`,
      NAME: name || "Contato Portal",
      SOURCE_ID: "WEB",

      COMMENTS:
        `Mensagem original: ${message || ""}\n\n` +
        `Código do imóvel: ${codigoImovel}\n` +
        `ClientCode: ${clientCode || ""}\n` +
        `Navplat: ${idNavplat || ""}\n` +
        `EventId: ${eventId || ""}\n` +
        `MessageId: ${messageId || ""}\n` +
        `InternalRefere
