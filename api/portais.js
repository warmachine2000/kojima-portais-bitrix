const axios = require("axios");

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || null;

// --- Funções auxiliares ---

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

/**
 * Chamada genérica ao Bitrix.
 * - NÃO lança erro quando o Bitrix retorna { error, error_description }
 * - Só lança erro em falha de rede/time-out, etc.
 * - Sempre retorna o objeto inteiro `resp.data`
 */
async function bitrixCall(method, params) {
  if (!BITRIX_WEBHOOK_URL) {
    throw new Error("BITRIX_WEBHOOK_URL não definido nas variáveis de ambiente");
  }

  const url = `${BITRIX_WEBHOOK_URL}/${method}`;
  const resp = await axios.post(url, params, { timeout: 15000 });

  return resp.data;
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

// --- Handler para Vercel ---

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

   // Validação de token (aceita Authorization: Bearer xxx ou x-webhook-token)
  if (WEBHOOK_TOKEN) {
    const authHeader =
      req.headers["authorization"] || req.headers["Authorization"];
    const customHeader = req.headers["x-webhook-token"];

    let token = null;

    // 1) Prioriza Authorization: Bearer xxx
    if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
      token = authHeader.slice(7).trim(); // remove "Bearer "
    }
    // 2) Fallback: x-webhook-token simples
    else if (customHeader) {
      token = String(customHeader).trim();
    }

    if (!token || token !== WEBHOOK_TOKEN) {
      return res.status(401).json({ error: "INVALID_TOKEN" });
    }
  }

  const payload = req.body || {};
  console.log("Payload recebido:", JSON.stringify(payload, null, 2));

  try {
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

  try {
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

    if (!name && !email && !phone) {
      return res
        .status(400)
        .json({ error: "Precisa de pelo menos nome, e-mail ou telefone" });
    }

    const phones = parsePhones(phone);
    const codigoImovel = extractCodigoImovel(message) || "NÃO INFORMADO";

    const duplicates = await findDuplicate(phones, email);
    const isDuplicate = hasLeadDuplicate(duplicates);

    let leadId = null;

    // --------------------------------------------------------
    // DUPLICIDADE → cria atividade no lead existente
    // --------------------------------------------------------
    if (isDuplicate) {
      const leadFromPhone = duplicates.PHONE?.LEAD?.[0];
      const leadFromEmail = duplicates.EMAIL?.LEAD?.[0];
      leadId = leadFromPhone || leadFromEmail;

      // COMMUNICATIONS exigido pelo Bitrix para crm.activity.add
      const communications = [];

      if (phones && phones.length) {
        communications.push(
          ...phones.map((p) => ({
            VALUE: p,
            VALUE_TYPE: "PHONE",
          }))
        );
      }

      if (email) {
        communications.push({
          VALUE: email,
          VALUE_TYPE: "EMAIL",
        });
      }

      const activityResp = await bitrixCall("crm.activity.add", {
        fields: {
          OWNER_ID: leadId,
          OWNER_TYPE_ID: 1, // 1 = Lead
          TYPE_ID: 4, // atividade genérica (pode deixar 4 ou 2 se quiser “ligação”)
          SUBJECT: `Novo contato Portal (duplicado) - ${codigoImovel}`,
          DESCRIPTION:
            `Novo contato vindo do portal.\n\n` +
            `Mensagem: ${message || ""}\n\n` +
            `Telefones: ${phones.join(", ")}\n` +
            `E-mail: ${email || "não informado"}`,
          COMPLETED: "N",
          RESPONSIBLE_ID: 1,
          COMMUNICATIONS: communications,
        },
      });

      // Se o Bitrix reclamar de algo, retornamos 400 com detalhes
      if (activityResp && activityResp.error) {
        return res.status(400).json({
          status: "DUPLICATE_ACTIVITY_ERROR",
          bitrix: activityResp,
        });
      }

      return res.json({
        status: "DUPLICATE_ACTIVITY_CREATED",
        leadId,
        bitrix: activityResp,
      });
    }

    // --------------------------------------------------------
    // SEM DUPLICIDADE → cria LEAD novo
    // --------------------------------------------------------
    const leadResp = await bitrixCall("crm.lead.add", {
      fields: {
        TITLE: `Lead Portal | ${codigoImovel} | ${name || "Sem nome"}`,
        NAME: name || "Contato Portal",
        SOURCE_ID: (
  publicationPlan?.toLowerCase().includes("wim") ? "WIMOVEIS" :
  publicationPlan?.toLowerCase().includes("imo") ? "IMOVELWEB" :
  "OTHER"
),
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
      },
    });

    if (leadResp && leadResp.error) {
      // erro vindo do Bitrix na criação do lead
      return res.status(400).json({
        status: "LEAD_CREATE_ERROR",
        bitrix: leadResp,
      });
    }

    leadId = leadResp.result || leadResp; // dependendo de como o Bitrix retornar

    return res.json({
      status: "LEAD_CREATED",
      leadId,
      bitrix: leadResp,
    });
  } catch (err) {
    console.error("Erro geral:", err.message, err?.response?.data);
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
};
