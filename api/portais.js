// /api/portais.js
// Handler de TESTE para garantir que a função na Vercel está ok

module.exports = async (req, res) => {
  try {
    console.log("=== TESTE /api/portais ===");
    console.log("Método:", req.method);
    console.log("Headers:", req.headers);
    console.log("Body bruto:", req.body);

    // Só pra checar se o body veio como string ou objeto
    let payload = req.body;
    if (typeof req.body === "string") {
      try {
        payload = JSON.parse(req.body);
      } catch (e) {
        console.log("Body não é JSON válido, usando string mesmo");
      }
    }

    return res.status(200).json({
      status: "OK_TEST",
      message: "Função /api/portais está rodando na Vercel",
      method: req.method,
      payload,
    });
  } catch (err) {
    console.error("Erro dentro do handler de teste:", err);

    return res.status(500).json({
      error: "TEST_INTERNAL_ERROR",
      message: err.message || null,
    });
  }
};

