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
  const resp = await axios.post(url, params, { timeout: 15000 });

  if (resp.data && resp.data.error) {
    throw new Error(
      `Bitrix error ${resp.data.error}: ${resp.data.error_description}`
    );
  }

  return resp.data.result;
}

async function findDuplicate(phones, email) {
  let duplicates = { PHONE: null, EMAIL: null };

  if (phones && phones.length) {
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
      console.warn("Erro duplicidade email:", e.message);
    }
  }

  return duplicates;
}

function hasLeadDuplicate(duplicates) {
  if (!duplicates) return false;

  const leadIdsPhone = duplicates.PHONE?.LEAD || [];
  const leadIdsEmail = duplicates.EMAIL?.LEAD || [];

  return (
    (Array.isArray(leadIdsPhone) && leadIdsPhone.length > 0) ||
    (Array.isArray(leadIdsEmail) && leadIdsEmail.length > 0)
  );
}

// ----------------- Handler Vercel -----------------

module.exports = async (req, res) => {
  try {
    // Só aceita POST
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Validação de token opcional
    if (WEBHOOK_TOKEN) {
      const tokenHeader = req.headers["x-webhook-token"];
      if (tokenHeader !== WEBHOOK_TOKEN) {
        return res.status(401).json({ error: "INVALID_TOKEN" });
      }
    }

    // Parse seguro do body (string ou objeto)
    let payload = {};

    if (!req.body) {
      return res.status(400).json({ error: "EMPTY_BODY" });
    }

    if (typeof req.body === "string") {
      try {
        payload = JSON.parse(req.body || "{}");
      } catch (e) {
        console.error("Erro ao fazer parse do JSON:", e);
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
      eventType,
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

    // Pelo menos um identificador básico
    if (!name && !email && !phone) {
      return res
        .status(400)
        .json({ error: "Precisa de pelo menos nome, e-mail ou telefone" });
    }

    const phones = parsePhones(phone);
    const codigoImovel = extractCodigoImovel(message) || "NÃO INFORMADO";

    // Verifica duplicidade
    const duplicates = await findDuplicate(phones, email);
    const isDuplicate = hasLeadDuplicate(duplicates);

    let leadId = null;

    // ----------------- CASO DUPLICADO: cria atividade -----------------
    if (isDuplicate) {
      const leadFromPhone = duplicates.PHONE?.LEAD?.[0];
      const leadFromEmail = duplicates.EMAIL?.LEAD?.[0];
      leadId = leadFromPhone || leadFromEmail;

      await bitrixCall("crm.activity.add", {
        fields: {
          OWNER_ID: leadId,
          OWNER_TYPE_ID: 1, // Lead
          TYPE_ID: 4, // chamada (pra ficar mais visível)
          SUBJECT: `Novo contato Portal (duplicado) - ${codigoImovel}`,
          DESCRIPTION:
            `Novo contato vindo do portal.\n\n` +
            `Mensagem: ${message || ""}\n\n` +
            `Telefones: ${phones.join(", ")}\n` +
            `E-mail: ${email || "não informado"}`,
          COMPLETED: "N",
          RESPONSIBLE_ID: 1,
        },
      });

      return res.json({
        status: "DUPLICATE_ACTIVITY_CREATED",
        leadId,
      });
    }

    // ----------------- CASO NOVO: cria LEAD -----------------

    // Se quiser diferenciar Imovelweb / Wimóveis pela publicationPlan, dá pra brincar aqui
    const sourceId = "WEB";

    const leadResult = await bitrixCall("crm.lead.add", {
      fields: {
        TITLE: `Lead Portal | ${codigoImovel} | ${name || "Sem nome"}`,
        NAME: name || "Contato Portal",
        SOURCE_ID: sourceId,
        PHONE: phones.map((p) => ({ VALUE: p, VALUE_TYPE: "WORK" })),
        EMAIL: email ? [{ VALUE: email, VALUE_TYPE: "WORK" }] : [],
        COMMENTS:
          `Mensagem original: ${message || ""}\n\n` +
          `Código do imóvel: ${codigoImovel}\n` +
          `ClientCode: ${clientCode || ""}\n` +
          `Navplat: ${idNavplat || ""}\n` +
          `EventId: ${eventId || ""}\n` +
          `MessageId: ${messageId || ""}\n` +
          `InternalReference: ${internalReference || ""}\n` +
          `PublicationPlan: ${publicationPlan || ""}\n` +
          `UserIdNavplat: ${userIdNavplat || ""}\n` +
          `ContactTypeId: ${contactTypeId || ""}\n` +
          `RegisterDate: ${registerDate || ""}`,
        UF_CODIGO_IMOVEL: codigoImovel,
        UF_EVENT_ID: eventId,
        UF_MESSAGE_ID: messageId,
        UF_CONTACT_ID: contactId,
        UF_NAVPLAT_ID: idNavplat,
        UF_CLIENT_CODE: clientCode,
        UF_PORTAL_ORIGEM: "IMOVELWEB_WIMOVEIS_CASAMINEIRA",
        // se quiser depois plugamos aqui o UF_CRM_ORIGIN_URL quando tivermos a URL
      },
    });

    leadId = leadResult;

    return res.json({
      status: "LEAD_CREATED",
      leadId,
    });
   } catch (err) {
    console.error("Erro geral na função:", err);

    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: err.message || null,
      stack: err.stack || null,
    });
  }
};
