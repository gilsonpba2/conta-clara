// Resgate de voucher pelo usuário logado
import { redis, redisVarios, paraObjeto, bancoConfigurado } from "../lib/redis.js";
import { lerToken } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido." });
  if (!bancoConfigurado()) return res.status(500).json({ erro: "Banco de dados não configurado." });

  const email = lerToken(req);
  if (!email) return res.status(401).json({ erro: "Entre na sua conta para usar um voucher." });

  const codigo = String(req.body?.codigo || "").trim().toUpperCase();
  if (!codigo) return res.status(400).json({ erro: "Digite o código do voucher." });

  try {
    const v = paraObjeto(await redis("HGETALL", `voucher:${codigo}`));
    if (!v || v.ativo === "0") return res.status(404).json({ erro: "Voucher inválido." });
    if (v.validade && new Date(v.validade + "T23:59:59-03:00") < new Date()) {
      return res.status(410).json({ erro: "Este voucher venceu." });
    }

    // Cada pessoa usa o mesmo voucher uma vez só
    const primeiraVez = await redis("SADD", `voucher:${codigo}:usuarios`, email);
    if (!primeiraVez) return res.status(409).json({ erro: "Você já usou este voucher." });

    const usos = await redis("HINCRBY", `voucher:${codigo}`, "usos", 1);
    const max = parseInt(v.usos_max || "1", 10);
    if (max > 0 && usos > max) {
      await redisVarios([
        ["HINCRBY", `voucher:${codigo}`, "usos", -1],
        ["SREM", `voucher:${codigo}:usuarios`, email],
      ]);
      return res.status(410).json({ erro: "Este voucher já atingiu o limite de usos." });
    }

    const qtd = parseInt(v.creditos || "0", 10);
    const creditos = await redis("INCRBY", `creditos:${email}`, qtd);
    return res.status(200).json({ ok: true, adicionados: qtd, creditos });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro no servidor. Tente de novo." });
  }
}
