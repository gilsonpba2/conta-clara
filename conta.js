// Cadastro, login e dados da conta do usuário
import { redis, redisVarios, paraObjeto, bancoConfigurado } from "../lib/redis.js";
import { normalizarEmail, emailValido, gerarHashSenha, conferirSenha, criarToken, lerToken } from "../lib/auth.js";

const CREDITOS_INICIAIS = parseInt(process.env.CREDITOS_INICIAIS ?? "1", 10);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido." });
  if (!bancoConfigurado()) return res.status(500).json({ erro: "Banco de dados não configurado." });

  const { acao } = req.body || {};
  try {
    if (acao === "cadastrar") return await cadastrar(req, res);
    if (acao === "entrar") return await entrar(req, res);
    if (acao === "eu") return await eu(req, res);
    if (acao === "excluir") return await excluir(req, res);
    return res.status(400).json({ erro: "Ação inválida." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro no servidor. Tente de novo." });
  }
}

async function cadastrar(req, res) {
  const email = normalizarEmail(req.body.email);
  const nome = String(req.body.nome || "").trim().slice(0, 80);
  const senha = String(req.body.senha || "");
  if (!nome) return res.status(400).json({ erro: "Informe seu nome." });
  if (!emailValido(email)) return res.status(400).json({ erro: "E-mail inválido." });
  if (senha.length < 6) return res.status(400).json({ erro: "A senha precisa ter pelo menos 6 caracteres." });

  const { sal, hash } = gerarHashSenha(senha);
  // HSETNX garante que não sobrescreve um cadastro existente
  const novo = await redis("HSETNX", `usuario:${email}`, "hash", hash);
  if (!novo) return res.status(409).json({ erro: "Já existe uma conta com esse e-mail. Use Entrar." });

  await redisVarios([
    ["HSET", `usuario:${email}`, "sal", sal, "nome", nome, "criado", new Date().toISOString()],
    ["SADD", "usuarios", email],
    ["SET", `creditos:${email}`, CREDITOS_INICIAIS],
  ]);
  return res.status(200).json({ token: criarToken(email), nome, email, creditos: CREDITOS_INICIAIS });
}

async function entrar(req, res) {
  const email = normalizarEmail(req.body.email);
  const senha = String(req.body.senha || "");
  const u = paraObjeto(await redis("HGETALL", `usuario:${email}`));
  if (!u || !u.sal || !conferirSenha(senha, u.sal, u.hash)) {
    return res.status(401).json({ erro: "E-mail ou senha incorretos." });
  }
  const creditos = parseInt((await redis("GET", `creditos:${email}`)) || "0", 10);
  return res.status(200).json({ token: criarToken(email), nome: u.nome, email, creditos });
}

async function eu(req, res) {
  const email = lerToken(req);
  if (!email) return res.status(401).json({ erro: "Sessão expirada. Entre de novo." });
  const [dados, creditos] = await redisVarios([
    ["HGETALL", `usuario:${email}`],
    ["GET", `creditos:${email}`],
  ]);
  const u = paraObjeto(dados);
  if (!u) return res.status(401).json({ erro: "Conta não encontrada." });
  return res.status(200).json({ nome: u.nome, email, creditos: parseInt(creditos || "0", 10) });
}

// LGPD: o próprio usuário apaga a conta e o histórico
async function excluir(req, res) {
  const email = lerToken(req);
  if (!email) return res.status(401).json({ erro: "Sessão expirada." });
  const u = paraObjeto(await redis("HGETALL", `usuario:${email}`));
  if (!u || !conferirSenha(String(req.body.senha || ""), u.sal, u.hash)) {
    return res.status(401).json({ erro: "Senha incorreta." });
  }
  const ucs = (await redis("SMEMBERS", `ucs:${email}`)) || [];
  await redisVarios([
    ["DEL", `usuario:${email}`, `creditos:${email}`, `analises:${email}`, `ucs:${email}`, ...ucs.flatMap((uc) => [`gd:${email}:${uc}`, `ga:${email}:${uc}`, `gainfo:${email}:${uc}`])],
    ["SREM", "usuarios", email],
  ]);
  return res.status(200).json({ ok: true });
}
