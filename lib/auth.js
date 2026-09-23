// Senhas e sessões. Nada de pacote externo: usa o módulo crypto do próprio Node.
import crypto from "node:crypto";

const DURACAO_SESSAO_DIAS = 30;

function segredo() {
  const s = process.env.SESSAO_SEGREDO || process.env.ANTHROPIC_API_KEY || "";
  return crypto.createHash("sha256").update("conta-clara:" + s).digest();
}

export function normalizarEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function emailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function gerarHashSenha(senha) {
  const sal = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(senha), sal, 64).toString("hex");
  return { sal, hash };
}

export function conferirSenha(senha, sal, hashSalvo) {
  const hash = crypto.scryptSync(String(senha), sal, 64);
  const salvo = Buffer.from(hashSalvo, "hex");
  return salvo.length === hash.length && crypto.timingSafeEqual(hash, salvo);
}

export function criarToken(email) {
  const expira = Date.now() + DURACAO_SESSAO_DIAS * 24 * 3600 * 1000;
  const corpo = Buffer.from(JSON.stringify({ e: email, x: expira })).toString("base64url");
  const assinatura = crypto.createHmac("sha256", segredo()).update(corpo).digest("base64url");
  return corpo + "." + assinatura;
}

// Devolve o e-mail do usuário logado, ou null
export function lerToken(req) {
  const cab = req.headers?.authorization || "";
  const token = cab.startsWith("Bearer ") ? cab.slice(7) : "";
  const [corpo, assinatura] = token.split(".");
  if (!corpo || !assinatura) return null;
  const esperada = crypto.createHmac("sha256", segredo()).update(corpo).digest("base64url");
  const a = Buffer.from(assinatura), b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { e, x } = JSON.parse(Buffer.from(corpo, "base64url").toString());
    return x > Date.now() ? e : null;
  } catch {
    return null;
  }
}

export function senhaAdminOk(req) {
  const esperada = process.env.ADMIN_SENHA;
  const enviada = req.headers?.["x-admin-senha"] || "";
  if (!esperada) return false;
  const a = Buffer.from(String(enviada)), b = Buffer.from(esperada);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function gerarCodigoVoucher() {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem 0/O/1/I para não confundir
  let c = "";
  for (let i = 0; i < 8; i++) c += letras[crypto.randomInt(letras.length)];
  return "CC-" + c;
}
