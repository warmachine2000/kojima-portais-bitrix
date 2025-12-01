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

  try {
    const resp = await axios.post(url, params, { timeout: 15000 });
    return resp.data; // pode conter { result } ou { error, error_description }
  } catch (err) {
    console.error("Erro ao chamar Bitrix:", {
      method,
      url,
      status: err.response?.status,
      data: err.response?.data,
      message: err.message
    });

    return {
      error: "BITRIX_REQUEST_FAILED",
      details: err.response?.data || err.message
    };
  }
}

async function findDuplicate(phones, email) {
  let duplicates = { PHONE: null, EMAIL: null };

  // TELEFONE
  if (phones && phones.length) {
    try {
      const resultPhone = await bitrixCall("crm.duplicate.findbycomm", {
        type: "PHONE",
        values: phones
      });

      if (!resultPhone.error) {
        // aqui usamos o `result` da resposta Bitrix
        duplicates.PHONE = resultPhone.result;
      } else {
        console.warn("Erro duplicidade telefone (Bitrix):", resultPhone);
      }
    } catch (e) {
      console.warn("Erro duplicidade telefone (exception):", e.message);
    }
  }

  // EMAIL
  if (email) {
    try {
      const resultEmail = await bitrixCall("crm.duplicate.findbycomm", {
        type: "EMAIL",
        values: [email]
      });

      if (!resultEmail.error) {
        duplicates.EMAIL = resultEmail.result;
      } else {
        console.warn("Erro duplicidade email (Bitrix):", resultEmail);
      }
    } catch (e) {
      console.warn("Erro duplicidade email (exception):", e.message);
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

  // Validação de token opcional
  if (WEBHOOK_TOKEN) {
    const tokenHeader = req.headers["x-webhook-token"];
    if (tokenHeader !== WEBHOOK_TOKEN) {
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
      registerDate
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

    // DUPLICIDADE → cria atividade
    if (isDuplicate) {
      const leadFromPhone = duplicates.PHONE?.LEAD?.[0];
      const leadFromEmail = duplicates.EMAIL?.LEAD?.[0];
      leadId = leadFromPhone || leadFromEmail;

      const activityResp = await bitrixCall("crm.activity.add", {
        fields: {
          OWNER_ID: leadId,
          OWNER_TYPE_ID: 1,
          TYPE_ID: 2,
          SUBJECT: `Novo contato Portal (duplicado) - ${codigoImovel}`,
          DESCRIPTION:
            `Novo contato vindo do portal.\n\n` +
            `Mensagem: ${message || ""}\n\n` +
            `Telefones: ${phones.join(", ")}\n` +
            `E-mail: ${email || "não informado"}`,
          COMPLETED: "N",
          RESPONSIBLE_ID: 1
        }
      });

      if (activityResp.error) {
        // erro vindo do Bitrix ao criar atividade
        return res.status(400).json({
          status: "DUPLICATE_ACTIVITY_ERROR",
          bitrix: activityResp
        });
      }

      return res.json({
        status: "DUPLICATE_ACTIVITY_CREATED",
        leadId
      });
    }

    // SEM DUPLICIDADE → cria LEAD novo
    const resultLead = await bitrixCall("crm.lead.add", {
      fields: {
        TITLE: `Lead Portal | ${codigoImovel} | ${name || "Sem nome"}`,
        NAME: name || "Contato Portal",
        SOURCE_ID: "WEB",
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
        UF_PORTAL_ORIGEM: "IMOVELWEB_WIMOVEIS_CASAMINEIRA"
      }
    });

    // Se o Bitrix devolver erro, repassamos para o cliente (Postman/Facilita/etc.)
    if (resultLead.error) {
      return res.status(400).json({
        status: "BITRIX_LEAD_ERROR",
        bitrix: resultLead
      });
    }

    leadId = resultLead.result;

    return res.json({
      status: "LEAD_CREATED",
      leadId
    });
  } catch (err) {
    console.error("Erro geral na API /api/portais:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: err.message
      // se quiser MUITO detalhado: stack: err.stack
    });
  }
};
