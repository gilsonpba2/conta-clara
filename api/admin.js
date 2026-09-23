// Painel administrativo: vouchers, créditos e usuários. Protegido pela variável ADMIN_SENHA.
import { redis, redisVarios, paraObjeto, bancoConfigurado } from "../lib/redis.js";
import { senhaAdminOk, normalizarEmail, gerarHashSenha, gerarCodigoVoucher } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido." });
  if (!process.env.ADMIN_SENHA) return res.status(500).json({ erro: "Cadastre a variável ADMIN_SENHA na Vercel." });
  if (!senhaAdminOk(req)) return res.status(401).json({ erro: "Senha de administrador incorreta." });
  if (!bancoConfigurado()) return res.status(500).json({ erro: "Banco de dados não configurado." });

  const b = req.body || {};
  try {
    switch (b.acao) {
      case "painel": return res.status(200).json(await painel());
      case "criar_voucher": return await criarVoucher(b, res);
      case "desativar_voucher":
        await redis("HSET", `voucher:${String(b.codigo).toUpperCase()}`, "ativo", "0");
        return res.status(200).json({ ok: true });
      case "ajustar_creditos": return await ajustarCreditos(b, res);
      case "redefinir_senha": return await redefinirSenha(b, res);
      default: return res.status(400).json({ erro: "Ação inválida." });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro no servidor: " + e.message });
  }
}

async function painel() {
  const [emails, codigos] = await redisVarios([["SMEMBERS", "usuarios"], ["SMEMBERS", "vouchers"]]);
  const listaEmails = (emails || []).slice(0, 500);
  const listaCodigos = codigos || [];

  let usuarios = [];
  if (listaEmails.length) {
    const r = await redisVarios(listaEmails.flatMap((e) => [
      ["HGET", `usuario:${e}`, "nome"],
      ["HGET", `usuario:${e}`, "criado"],
      ["GET", `creditos:${e}`],
      ["LLEN", `analises:${e}`],
    ]));
    usuarios = listaEmails.map((email, i) => ({
      email, nome: r[i * 4], criado: r[i * 4 + 1], creditos: parseInt(r[i * 4 + 2] || "0", 10), analises: r[i * 4 + 3],
    })).sort((a, b) => String(b.criado).localeCompare(String(a.criado)));
  }

  let vouchers = [];
  if (listaCodigos.length) {
    const r = await redisVarios(listaCodigos.map((c) => ["HGETALL", `voucher:${c}`]));
    vouchers = listaCodigos.map((codigo, i) => ({ codigo, ...paraObjeto(r[i]) }))
      .sort((a, b) => String(b.criado).localeCompare(String(a.criado)));
  }
  return { usuarios, vouchers };
}

async function criarVoucher(b, res) {
  const creditos = parseInt(b.creditos, 10);
  const usosMax = parseInt(b.usos_max ?? 1, 10);
  if (!(creditos > 0)) return res.status(400).json({ erro: "Informe quantos créditos o voucher dá." });
  if (!(usosMax >= 0)) return res.status(400).json({ erro: "Número de usos inválido (0 = ilimitado)." });

  const codigo = String(b.codigo || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "") || gerarCodigoVoucher();
  const criado = await redis("HSETNX", `voucher:${codigo}`, "creditos", creditos);
  if (!criado) return res.status(409).json({ erro: "Já existe um voucher com esse código." });

  const campos = ["usos_max", usosMax, "usos", 0, "ativo", "1", "criado", new Date().toISOString(), "descricao", String(b.descricao || "").slice(0, 100)];
  if (b.validade) campos.push("validade", String(b.validade).slice(0, 10));
  await redisVarios([["HSET", `voucher:${codigo}`, ...campos], ["SADD", "vouchers", codigo]]);
  return res.status(200).json({ ok: true, codigo });
}

async function ajustarCreditos(b, res) {
  const email = normalizarEmail(b.email);
  const qtd = parseInt(b.quantidade, 10);
  if (!(await redis("EXISTS", `usuario:${email}`))) return res.status(404).json({ erro: "Usuário não encontrado." });
  if (!qtd) return res.status(400).json({ erro: "Informe a quantidade (use negativo para retirar)." });
  const creditos = await redis("INCRBY", `creditos:${email}`, qtd);
  return res.status(200).json({ ok: true, creditos });
}

async function redefinirSenha(b, res) {
  const email = normalizarEmail(b.email);
  const nova = String(b.nova_senha || "");
  if (nova.length < 6) return res.status(400).json({ erro: "A nova senha precisa ter pelo menos 6 caracteres." });
  if (!(await redis("EXISTS", `usuario:${email}`))) return res.status(404).json({ erro: "Usuário não encontrado." });
  const { sal, hash } = gerarHashSenha(nova);
  await redis("HSET", `usuario:${email}`, "sal", sal, "hash", hash);
  return res.status(200).json({ ok: true });
}
