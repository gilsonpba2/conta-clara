// Histórico do usuário: faturas analisadas e créditos de GD mês a mês, por unidade consumidora
import { redis, redisVarios, paraObjeto, bancoConfigurado } from "../lib/redis.js";
import { lerToken } from "../lib/auth.js";

export default async function handler(req, res) {
  if (!bancoConfigurado()) return res.status(500).json({ erro: "Banco de dados não configurado." });
  const email = lerToken(req);
  if (!email) return res.status(401).json({ erro: "Sessão expirada. Entre de novo." });

  try {
    const [analisesBrutas, ucs] = await redisVarios([
      ["LRANGE", `analises:${email}`, 0, 99],
      ["SMEMBERS", `ucs:${email}`],
    ]);
    const todas = (analisesBrutas || []).map((a) => JSON.parse(a));

    // ?id=xxx devolve uma análise completa para reabrir
    const id = req.query?.id;
    if (id) {
      const achada = todas.find((a) => a.id === id);
      if (!achada) return res.status(404).json({ erro: "Análise não encontrada." });
      return res.status(200).json(achada.completa);
    }

    const analises = todas.map(({ completa, ...resumo }) => resumo);

    const unidades = [];
    if (ucs && ucs.length) {
      const gdBrutos = await redisVarios(ucs.map((uc) => ["HGETALL", `gd:${email}:${uc}`]));
      ucs.forEach((uc, i) => {
        const obj = paraObjeto(gdBrutos[i]) || {};
        const meses = Object.entries(obj)
          .map(([mes, v]) => ({ mes, ...JSON.parse(v) }))
          .sort((a, b) => b.mes.localeCompare(a.mes));
        const comSaldo = meses.find((m) => typeof m.saldo_kwh === "number");
        unidades.push({
          uc,
          saldo_atual_kwh: comSaldo ? comSaldo.saldo_kwh : null,
          saldo_referencia: comSaldo ? comSaldo.mes : null,
          meses,
        });
      });
    }
    return res.status(200).json({ analises, unidades });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro ao carregar o histórico." });
  }
}
